import { type TransactionResponse } from '@ethersproject/abstract-provider';
import { MAX_BLOCKCOUNT, SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type PopulatedTransaction, Wallet, utils } from 'ethers';
import { InquirerService } from 'nest-commander';
import { oraPromise as spinnerFor } from 'ora';

import { bigIntMax, bigIntMin, percentile } from './utils/common.js';
import { ConfigService } from '../../config/config.service.js';
import { WorkingMode } from '../../config/env.validation.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService } from '../../prometheus/index.js';

// HighGasFeeError: retry with a fixed 60s delay for ~2 beacon epochs total,
// then surface the error so the daemon can move on. The root stays in the
// stack and gets re-attempted on the next loop iteration. Other tasks (keys
// indexer, bad performers) keep running in parallel via separate SingletonTasks.
//
// 2 epochs = 2 × 32 slots × 12s = 768s ≈ 13 × 60s retries.
const HIGH_GAS_FEE_RETRY_DELAY_MS = 60_000;
const HIGH_GAS_FEE_MAX_RETRIES = 13;
// +20% safety buffer on estimateGas, to absorb state changes between
// estimation and inclusion.
const GAS_LIMIT_BUFFER_NUM = 12n;
const GAS_LIMIT_BUFFER_DEN = 10n;

export enum TransactionStatus {
  confirmed = 'confirmed',
  pending = 'pending',
  error = 'error',
}

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

const DEPOSIT_CONTRACT_ADDRESS = '0x00000000219ab540356cBB839Cbe05303d7705Fa';

@Injectable()
export class Execution {
  public signer?: Wallet;

  private gasFeeHistoryCache: bigint[] = [];
  private lastFeeHistoryBlockNumber = 0;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    @Optional() protected readonly prometheus: PrometheusService,
    @Optional() protected readonly inquirerService: InquirerService,
    public readonly provider: SimpleFallbackJsonRpcBatchProvider,
  ) {
    const key = this.config.get('TX_SIGNER_PRIVATE_KEY');
    if (key) this.signer = new Wallet(key, this.provider);
  }

  public async execute(
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    if (this.isCLI()) {
      return await this.executeCLI(populateTxCallback, payload);
    }
    return await this.executeDaemon(populateTxCallback, payload);
  }

  public async executeCLI(
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    try {
      await this._execute(populateTxCallback, payload);
      return;
    } catch (e) {
      if (e instanceof NoSignerError || e instanceof DryRunError) {
        this.logger.warn(e);
        return;
      }
      this.logger.error(e);
      throw e;
    }
  }

  public async executeDaemon(
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    let highGasAttempts = 0;
    while (true) {
      try {
        this.prometheus.transactionCount.inc({ status: TransactionStatus.pending });
        await this._execute(populateTxCallback, payload);
        this.prometheus.transactionCount.inc({ status: TransactionStatus.confirmed });
        return;
      } catch (e) {
        if (e instanceof NoSignerError || e instanceof DryRunError) {
          this.logger.warn(e);
          return;
        }
        if (e instanceof HighGasFeeError && highGasAttempts < HIGH_GAS_FEE_MAX_RETRIES) {
          this.prometheus.highGasFeeInterruptionsCount.inc();
          this.logger.warn(e);
          highGasAttempts++;
          this.logger.warn(
            `Retrying in ${HIGH_GAS_FEE_RETRY_DELAY_MS / 1000}s (${highGasAttempts}/${HIGH_GAS_FEE_MAX_RETRIES})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, HIGH_GAS_FEE_RETRY_DELAY_MS));
          continue;
        }
        // For HighGasFee after max retries: surface the error so the daemon
        // loop can move on and re-attempt this root on a later iteration.
        this.prometheus.transactionCount.inc({ status: TransactionStatus.error });
        this.logger.error(e);
        throw e;
      } finally {
        this.prometheus.transactionCount.dec({ status: TransactionStatus.pending });
      }
    }
  }

  private async _execute(
    populateTxCallback: (...payload: any[]) => Promise<PopulatedTransaction>,
    payload: any[],
  ): Promise<void> {
    this.logger.debug!(payload);
    const priorityFeeParams = await this.calcPriorityFee();
    const txBase = {
      ...(await populateTxCallback(...payload)),
      maxFeePerGas: priorityFeeParams.maxFeePerGas,
      maxPriorityFeePerGas: priorityFeeParams.maxPriorityFeePerGas,
    };
    this.logger.log('Emulating call');
    const from = this.signer?.address ?? DEPOSIT_CONTRACT_ADDRESS;
    const emulatedTx = { ...txBase, from };
    const emulatedTxContext: { payload: any[]; tx: any } = { payload, tx: emulatedTx };
    let estimatedGas: bigint;
    try {
      await this.provider.call(emulatedTx);
      estimatedGas = (await this.provider.estimateGas(emulatedTx)).toBigInt();
    } catch (e) {
      throw new EmulatedCallError(e, emulatedTxContext);
    }
    // Use estimateGas (+20%) as the actual gasLimit; cap by TX_GAS_LIMIT.
    const gasLimit = (estimatedGas * GAS_LIMIT_BUFFER_NUM) / GAS_LIMIT_BUFFER_DEN;
    const cap = BigInt(this.config.get('TX_GAS_LIMIT'));
    if (gasLimit > cap) {
      throw new EmulatedCallError(
        `Estimated gas ${estimatedGas} (+20% = ${gasLimit}) exceeds TX_GAS_LIMIT cap (${cap}).`,
        emulatedTxContext,
      );
    }
    const tx = { ...txBase, gasLimit };
    this.logger.log(`✅ Emulated call succeeded. Estimated gas: ${estimatedGas} → gasLimit: ${gasLimit}`);
    if (!this.signer) {
      throw new NoSignerError('No specified signer. Only emulated calls are available', emulatedTxContext);
    }
    const populatedTx = await this.signer.populateTransaction(tx);
    const populatedTxContext: { payload: any[]; tx: any } = { payload, tx: populatedTx };
    const isFeePerGasAcceptable = await this.isFeePerGasAcceptable();
    if (this.config.get('DRY_RUN')) {
      throw new DryRunError('Dry run mode is enabled. Transaction is prepared, but not sent', populatedTxContext);
    }
    if (this.isCLI()) {
      const txSummary = [
        `to=${populatedTx.to ?? 'n/a'}`,
        `nonce=${String(populatedTx.nonce ?? 'n/a')}`,
        `gasLimit=${String(populatedTx.gasLimit ?? 'n/a')}`,
        `maxFeePerGas=${String(populatedTx.maxFeePerGas ?? 'n/a')}`,
        `maxPriorityFeePerGas=${String(populatedTx.maxPriorityFeePerGas ?? 'n/a')}`,
      ].join(' | ');
      const opts = await this.inquirerService.ask('tx-execution', {
        sendingConfirmed: false,
        txSummary,
      } as { sendingConfirmed: boolean; txSummary: string });
      if (!opts.sendingConfirmed) {
        throw new UserCancellationError('Transaction is not sent due to user cancellation', populatedTxContext);
      }
    } else {
      if (!isFeePerGasAcceptable) {
        throw new HighGasFeeError('Transaction is not sent due to high gas fee', populatedTxContext);
      }
    }
    const signed = await this.signer.signTransaction(populatedTx);
    let submitted: TransactionResponse;
    try {
      const submittedPromise = this.provider.sendTransaction(signed);
      let msg = `Sending transaction with nonce ${populatedTx.nonce} and gasLimit: ${populatedTx.gasLimit}, maxFeePerGas: ${populatedTx.maxFeePerGas}, maxPriorityFeePerGas: ${populatedTx.maxPriorityFeePerGas}`;
      if (this.isCLI()) {
        spinnerFor(submittedPromise, { text: msg });
      } else {
        this.logger.log(msg);
      }
      submitted = await submittedPromise;
      this.logger.log(`Transaction sent to mempool. Hash: ${submitted.hash}`);
      const waitingPromise = this.provider.waitForTransaction(
        submitted.hash,
        this.config.get('TX_CONFIRMATIONS'),
        this.config.get('TX_MINING_WAITING_TIMEOUT_MS'),
      );
      msg = `Waiting until the transaction has been mined and confirmed ${this.config.get('TX_CONFIRMATIONS')} times`;
      if (this.isCLI()) {
        spinnerFor(waitingPromise, { text: msg });
      } else {
        this.logger.log(msg);
      }
      await waitingPromise;
    } catch (e) {
      // Dirty hack for switching to the next provider in case of failure in sending transaction process
      // @ts-expect-error 'accessing protected member'
      this.provider.switchToNextProvider();
      throw new SendTransactionError(e, populatedTxContext);
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
    this.logger.log('🔄 Calculating priority fee');
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

  private isCLI(): boolean {
    return this.config.get('WORKING_MODE') == WorkingMode.CLI;
  }
}
