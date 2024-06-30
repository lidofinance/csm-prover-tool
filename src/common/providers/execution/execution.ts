import { TransactionResponse } from '@ethersproject/abstract-provider';
import { MAX_BLOCKCOUNT, SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { PopulatedTransaction, Wallet, utils } from 'ethers';
import { InquirerService } from 'nest-commander';

import { bigIntMax, bigIntMin, percentile } from './utils/common';
import { ConfigService } from '../../config/config.service';
import { WorkingMode } from '../../config/env.validation';
import { PrometheusService } from '../../prometheus';

class ErrorWithContext extends Error {
  public readonly context: any;

  constructor(message?: string, ctx?: any) {
    super(message);
    this.context = ctx;
  }
}

class EmulatedCallError extends ErrorWithContext {}
class SendTransactionError extends ErrorWithContext {}
class HighGasFeeError extends ErrorWithContext {}
class UserCancellationError extends ErrorWithContext {}

class NoSignerError extends ErrorWithContext {}
class DryRunError extends ErrorWithContext {}

@Injectable()
export class Execution {
  public signer?: Wallet;

  private gasFeeHistoryCache: bigint[] = [];
  private lastFeeHistoryBlockNumber = 0;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
    @Optional() protected readonly inquirerService: InquirerService,
    public readonly provider: SimpleFallbackJsonRpcBatchProvider,
  ) {
    const key = this.config.get('TX_SIGNER_PRIVATE_KEY');
    if (key) this.signer = new Wallet(key, this.provider);
  }

  public async execute(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    try {
      await this._execute(emulateTxCallback, populateTxCallback, payload);
    } catch (e) {
      if (e instanceof NoSignerError || e instanceof DryRunError) {
        this.logger.warn(e);
        return;
      }
      this.logger.error(e);
      throw e;
    }
  }

  private async _execute(
    emulateTxCallback: (...payload: any[]) => Promise<any>,
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    this.logger.debug!(payload);
    const tx = await populateTxCallback(...payload);
    let context: { payload: any[]; tx?: any } = { payload, tx };
    this.logger.log('Emulating call');
    try {
      await emulateTxCallback(...payload);
    } catch (e) {
      throw new EmulatedCallError(e, context);
    }
    this.logger.log('✅ Emulated call succeeded');
    if (!this.signer) {
      throw new NoSignerError('No specified signer. Only emulated calls are available', context);
    }
    const priorityFeeParams = await this.calcPriorityFee();
    const populated = await this.signer.populateTransaction({
      ...tx,
      maxFeePerGas: priorityFeeParams.maxFeePerGas,
      maxPriorityFeePerGas: priorityFeeParams.maxPriorityFeePerGas,
      gasLimit: this.config.get('TX_GAS_LIMIT'),
    });
    context = { ...context, tx: populated };
    if (this.config.get('DRY_RUN')) {
      throw new DryRunError('Dry run mode is enabled. Transaction is prepared, but not sent', context);
    }
    const isFeePerGasAcceptable = await this.isFeePerGasAcceptable();
    if (this.config.get('WORKING_MODE') == WorkingMode.CLI) {
      const opts = await this.inquirerService.ask('tx-execution', {} as { sendingConfirmed: boolean });
      if (!opts.sendingConfirmed) {
        throw new UserCancellationError('Transaction is not sent due to user cancellation', context);
      }
    } else {
      if (!isFeePerGasAcceptable) {
        this.prometheus.highGasFeeInterruptionsCount.inc();
        throw new HighGasFeeError('Transaction is not sent due to high gas fee', context);
      }
    }
    const signed = await this.signer.signTransaction(populated);
    let submitted: TransactionResponse;
    try {
      submitted = await this.provider.sendTransaction(signed);
      await submitted.wait();
    } catch (e) {
      throw new SendTransactionError(e, context);
    }
    this.logger.log(`✅ Transaction succeeded! Hash: ${submitted?.hash}`);
  }

  //
  // Gas calc functions
  //

  private async isFeePerGasAcceptable(): Promise<boolean> {
    const { current, recommended } = await this.calcFeePerGas();
    const currentGwei = utils.formatUnits(current, 'gwei');
    const recommendedGwei = utils.formatUnits(recommended, 'gwei');
    const info = `Current: ${currentGwei} Gwei | Recommended: ${recommendedGwei} Gwei`;
    if (current > recommended) {
      this.logger.warn(`📛 Current gas fee is HIGH! ${info}`);
      return false;
    }
    this.logger.log(`✅ Current gas fee is OK! ${info}`);
    return true;
  }

  private async calcFeePerGas(): Promise<{ recommended: bigint; current: bigint }> {
    const { baseFeePerGas: currentFee } = await this.provider.getBlock('pending');
    await this.updateGasFeeHistoryCache();
    const recommended = percentile(this.gasFeeHistoryCache, this.config.get('TX_GAS_FEE_HISTORY_PERCENTILE'));
    return { recommended, current: currentFee?.toBigInt() ?? 0n };
  }

  private async calcPriorityFee(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const { baseFeePerGas } = await this.provider.getBlock('pending');
    const { reward } = await this.provider.getFeeHistory(1, 'latest', [
      this.config.get('TX_GAS_PRIORITY_FEE_PERCENTILE'),
    ]);
    const maxPriorityFeePerGas = bigIntMin(
      bigIntMax(reward.pop()?.pop()?.toBigInt() ?? 0n, BigInt(this.config.get('TX_MIN_GAS_PRIORITY_FEE'))),
      BigInt(this.config.get('TX_MAX_GAS_PRIORITY_FEE')),
    );
    const maxFeePerGas = BigInt(Number(baseFeePerGas)) * 2n + maxPriorityFeePerGas;
    this.logger.debug!(`Priority fee: ${maxPriorityFeePerGas} | Max fee: ${maxFeePerGas}`);
    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  private async updateGasFeeHistoryCache(): Promise<void> {
    const maxBlocksPerHour = (60 * 60) / 12;
    const maxBlocksPerDay = 24 * maxBlocksPerHour;
    const maxFeeHistoryCacheSize = this.config.get('TX_GAS_FEE_HISTORY_DAYS') * maxBlocksPerDay;

    const { number: latestBlockNumber } = await this.provider.getBlock('latest');

    const feeHistoryCacheBlocksDelay = latestBlockNumber - this.lastFeeHistoryBlockNumber;
    // TODO: what the buffer to update should be?
    if (feeHistoryCacheBlocksDelay < maxBlocksPerHour) return;

    this.logger.log('🔄 Updating gas fee history cache');

    let newGasFees: bigint[] = [];
    let blockCountPerRequest = MAX_BLOCKCOUNT;
    let latestBlockToRequest = latestBlockNumber;
    let totalBlockCountToFetch = Math.min(feeHistoryCacheBlocksDelay, maxFeeHistoryCacheSize);
    while (totalBlockCountToFetch > 0) {
      if (totalBlockCountToFetch < MAX_BLOCKCOUNT) {
        blockCountPerRequest = totalBlockCountToFetch;
      }
      const stats = await this.provider.getFeeHistory(blockCountPerRequest, latestBlockToRequest, []);
      // NOTE: `baseFeePerGas` includes the next block after the newest of the returned range,
      // so we need to exclude it
      stats.baseFeePerGas.pop();
      newGasFees = [...stats.baseFeePerGas.map((v) => v.toBigInt()), ...newGasFees];
      latestBlockToRequest -= blockCountPerRequest - 1;
      totalBlockCountToFetch -= blockCountPerRequest;
    }

    // update cache with new values
    this.gasFeeHistoryCache = [
      ...(this.gasFeeHistoryCache.length > newGasFees.length ? this.gasFeeHistoryCache.slice(newGasFees.length) : []),
      ...newGasFees,
    ];
    this.lastFeeHistoryBlockNumber = latestBlockNumber;
  }
}
