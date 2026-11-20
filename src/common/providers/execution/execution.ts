import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InquirerService } from 'nest-commander';
import { oraPromise as spinnerFor } from 'ora';
import {
  type Abi,
  type Address,
  type Chain,
  ContractFunctionExecutionError,
  type Hex,
  type PublicClient,
  TransactionExecutionError,
  type TransactionReceipt,
  type Transport,
  encodeFunctionData,
  formatGwei,
  parseGwei,
} from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { sendTransaction } from 'viem/actions';

import { createElClient } from './execution-client.js';
import { bigIntMax, bigIntMin, percentile } from './utils/common.js';
import { ConfigService } from '../../config/config.service.js';
import { WorkingMode } from '../../config/env.validation.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService } from '../../prometheus/index.js';

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
const MAX_BLOCKCOUNT = 1024n;

type ProofTx = {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
};

export type Simulate = (sender: { account: Address }) => Promise<{ request: ProofTx }>;

function simulatedCallContext(e: unknown) {
  if (!(e instanceof ContractFunctionExecutionError)) return undefined;
  return {
    payload: e.args,
    tx: {
      to: e.contractAddress,
      data: encodeFunctionData({ abi: e.abi, functionName: e.functionName, args: e.args }),
      from: e.sender,
    },
  };
}

@Injectable()
export class Execution {
  public readonly signer?: PrivateKeyAccount;
  public client: PublicClient<Transport, Chain>;

  private gasFeeHistoryCache: bigint[] = [];
  private lastFeeHistoryBlockNumber = 0n;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    @Optional() protected readonly prometheus: PrometheusService,
    @Optional() protected readonly inquirerService: InquirerService,
  ) {
    const key = this.config.get('TX_SIGNER_PRIVATE_KEY');
    if (key) this.signer = privateKeyToAccount(key);
  }

  public async init(): Promise<void> {
    this.client = await createElClient(this.config, this.logger, this.prometheus);
  }

  public async getBlockNumber(): Promise<bigint> {
    return await this.client.getBlockNumber({ cacheTime: 0 });
  }

  public async execute(simulate: Simulate): Promise<void> {
    if (this.isCLI()) {
      return await this.executeCLI(simulate);
    }
    return await this.executeDaemon(simulate);
  }

  public async executeCLI(simulate: Simulate): Promise<void> {
    try {
      await this._execute(simulate);
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

  public async executeDaemon(simulate: Simulate): Promise<void> {
    let highGasAttempts = 0;
    while (true) {
      try {
        this.prometheus.transactionCount.inc({ status: TransactionStatus.pending });
        await this._execute(simulate);
        this.prometheus.transactionCount.inc({ status: TransactionStatus.confirmed });
        return;
      } catch (e) {
        if (e instanceof NoSignerError || e instanceof DryRunError) {
          this.logger.warn(e);
          return;
        }
        const maxRetries = this.config.get('TX_HIGH_GAS_FEE_MAX_RETRIES');
        if (e instanceof HighGasFeeError && highGasAttempts < maxRetries) {
          this.prometheus.highGasFeeInterruptionsCount.inc();
          this.logger.warn(e);
          highGasAttempts++;
          const delayMs = this.config.get('TX_HIGH_GAS_FEE_RETRY_DELAY_MS');
          this.logger.warn(`Retrying in ${delayMs / 1000}s (${highGasAttempts}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        this.prometheus.transactionCount.inc({ status: TransactionStatus.error });
        this.logger.error(e);
        throw e;
      } finally {
        this.prometheus.transactionCount.dec({ status: TransactionStatus.pending });
      }
    }
  }

  private async _execute(simulate: Simulate): Promise<void> {
    const fees = await this.calcPriorityFee();
    this.logger.log('Emulating call');
    const from = this.signer?.address ?? DEPOSIT_CONTRACT_ADDRESS;
    let tx: ProofTx;
    try {
      ({ request: tx } = await simulate({ account: from }));
    } catch (e) {
      throw new EmulatedCallError(e, simulatedCallContext(e));
    }
    this.logger.debug!(tx.args);
    const txBase = {
      to: tx.address,
      data: encodeFunctionData(tx),
      value: tx.value,
      ...fees,
    };
    const emulatedTx = { ...txBase, from };
    const emulatedTxContext = { payload: tx.args, tx: emulatedTx };
    let estimatedGas: bigint;
    try {
      estimatedGas = await this.client.estimateContractGas({
        ...tx,
        account: from,
        ...fees,
      });
    } catch (e) {
      throw new EmulatedCallError(e, emulatedTxContext);
    }
    const bufferPct = BigInt(this.config.get('TX_GAS_LIMIT_BUFFER_PERCENT'));
    const gasLimit = (estimatedGas * (100n + bufferPct)) / 100n;
    const cap = BigInt(this.config.get('TX_GAS_LIMIT'));
    if (gasLimit > cap) {
      throw new EmulatedCallError(
        `Estimated gas ${estimatedGas} (+${bufferPct}% = ${gasLimit}) exceeds TX_GAS_LIMIT cap (${cap}).`,
        emulatedTxContext,
      );
    }
    this.logger.log(
      `✅ Emulated call succeeded. Estimated gas: ${estimatedGas} (+${bufferPct}%) → gasLimit: ${gasLimit}`,
    );
    if (!this.signer) {
      throw new NoSignerError('No specified signer. Only emulated calls are available', emulatedTxContext);
    }
    const populatedTx = {
      ...txBase,
      gas: gasLimit,
      chainId: this.client.chain.id,
      nonce: await this.client.getTransactionCount({ address: this.signer.address, blockTag: 'pending' }),
    };
    const populatedTxContext = { payload: tx.args, tx: populatedTx };
    const isFeePerGasAcceptable = await this.isFeePerGasAcceptable();
    if (this.config.get('DRY_RUN')) {
      throw new DryRunError('Dry run mode is enabled. Transaction is prepared, but not sent', populatedTxContext);
    }
    if (this.isCLI()) {
      const txSummary = [
        `to=${populatedTx.to}`,
        `nonce=${populatedTx.nonce}`,
        `gasLimit=${populatedTx.gas}`,
        `maxFeePerGas=${populatedTx.maxFeePerGas}`,
        `maxPriorityFeePerGas=${populatedTx.maxPriorityFeePerGas}`,
      ].join(' | ');
      const opts = await this.inquirerService.ask<{ sendingConfirmed: boolean; txSummary: string }>('tx-execution', {
        sendingConfirmed: false,
        txSummary,
      });
      if (!opts.sendingConfirmed) {
        throw new UserCancellationError('Transaction is not sent due to user cancellation', populatedTxContext);
      }
    } else {
      if (!isFeePerGasAcceptable) {
        throw new HighGasFeeError('Transaction is not sent due to high gas fee', populatedTxContext);
      }
    }
    let hash: Hex;
    let receipt: TransactionReceipt;
    try {
      const submittedPromise = sendTransaction(this.client, {
        ...populatedTx,
        account: this.signer,
      });
      let msg = `Sending transaction with nonce ${populatedTx.nonce} and gasLimit: ${populatedTx.gas}, maxFeePerGas: ${populatedTx.maxFeePerGas}, maxPriorityFeePerGas: ${populatedTx.maxPriorityFeePerGas}`;
      if (this.isCLI()) {
        spinnerFor(submittedPromise, { text: msg });
      } else {
        this.logger.log(msg);
      }
      hash = await submittedPromise;
      this.logger.log(`Transaction sent to mempool. Hash: ${hash}`);
      const waitingPromise = this.client.waitForTransactionReceipt({
        hash,
        checkReplacement: false,
        confirmations: this.config.get('TX_CONFIRMATIONS'),
        timeout: this.config.get('TX_MINING_WAITING_TIMEOUT_MS'),
      });
      msg = `Waiting until the transaction has been mined and confirmed ${this.config.get('TX_CONFIRMATIONS')} times`;
      if (this.isCLI()) {
        spinnerFor(waitingPromise, { text: msg });
      } else {
        this.logger.log(msg);
      }
      receipt = await waitingPromise;
    } catch (e) {
      throw new SendTransactionError(e instanceof TransactionExecutionError ? e.cause : e, populatedTxContext);
    }
    if (receipt.status !== 'success') {
      throw new SendTransactionError(
        `Transaction reverted on-chain (status ${receipt.status}). Hash: ${hash}`,
        populatedTxContext,
      );
    }
    this.logger.log(`✅ Transaction succeeded! Hash: ${hash}`);
  }

  //
  // Gas calc functions
  //

  private async isFeePerGasAcceptable(): Promise<boolean> {
    const { current, recommended } = await this.calcFeePerGas();
    const currentGwei = formatGwei(current);
    const recommendedGwei = formatGwei(recommended);
    const info = `Current: ${currentGwei} Gwei | Recommended: ${recommendedGwei} Gwei`;
    const maxBaseFeeGwei = this.config.get('TX_MAX_BASE_FEE_GWEI');
    if (maxBaseFeeGwei > 0) {
      const cap = parseGwei(String(maxBaseFeeGwei));
      if (current > cap) {
        this.logger.warn(`📛 Current base fee is above the absolute cap (${maxBaseFeeGwei} Gwei)! ${info}`);
        return false;
      }
    }
    // NOTE: the check below is relative to recent history, so it holds back cheap
    // transactions for a saving that is not worth the delay
    const minBaseFeeGwei = this.config.get('TX_MIN_BASE_FEE_GWEI');
    if (minBaseFeeGwei > 0) {
      const floor = parseGwei(String(minBaseFeeGwei));
      if (current <= floor) {
        this.logger.log(`✅ Current base fee is below the always-send floor (${minBaseFeeGwei} Gwei)! ${info}`);
        return true;
      }
    }
    if (current > recommended) {
      this.logger.warn(`📛 Current gas fee is HIGH! ${info}`);
      return false;
    }
    this.logger.log(`✅ Current gas fee is OK! ${info}`);
    return true;
  }

  private async calcFeePerGas(): Promise<{ recommended: bigint; current: bigint }> {
    const { baseFeePerGas: currentFee } = await this.client.getBlock({ blockTag: 'pending' });
    await this.updateGasFeeHistoryCache();
    const recommended = percentile(this.gasFeeHistoryCache, this.config.get('TX_GAS_FEE_HISTORY_PERCENTILE'));
    return { recommended, current: currentFee ?? 0n };
  }

  private async calcPriorityFee(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    this.logger.log('🔄 Calculating priority fee');
    const { baseFeePerGas } = await this.client.getBlock({ blockTag: 'pending' });
    const { reward } = await this.client.getFeeHistory({
      blockCount: 1,
      blockTag: 'latest',
      rewardPercentiles: [this.config.get('TX_GAS_PRIORITY_FEE_PERCENTILE')],
    });
    const maxPriorityFeePerGas = bigIntMin(
      bigIntMax(reward?.pop()?.pop() ?? 0n, BigInt(this.config.get('TX_MIN_GAS_PRIORITY_FEE'))),
      BigInt(this.config.get('TX_MAX_GAS_PRIORITY_FEE')),
    );
    const maxFeePerGas = (baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
    this.logger.debug!(`Priority fee: ${maxPriorityFeePerGas} | Max fee: ${maxFeePerGas}`);
    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  private async updateGasFeeHistoryCache(): Promise<void> {
    const maxBlocksPerHour = (60n * 60n) / 12n;
    const maxBlocksPerDay = 24n * maxBlocksPerHour;
    const maxFeeHistoryCacheSize = BigInt(this.config.get('TX_GAS_FEE_HISTORY_DAYS')) * maxBlocksPerDay;

    const latestBlockNumber = await this.getBlockNumber();

    const feeHistoryCacheBlocksDelay = latestBlockNumber - this.lastFeeHistoryBlockNumber;
    // TODO: what the buffer to update should be?
    if (feeHistoryCacheBlocksDelay < maxBlocksPerHour) return;

    this.logger.log('🔄 Updating gas fee history cache');

    let newGasFees: bigint[] = [];
    let blockCountPerRequest = MAX_BLOCKCOUNT;
    let latestBlockToRequest = latestBlockNumber;
    let totalBlockCountToFetch = bigIntMin(feeHistoryCacheBlocksDelay, maxFeeHistoryCacheSize);
    while (totalBlockCountToFetch > 0n) {
      if (totalBlockCountToFetch < MAX_BLOCKCOUNT) {
        blockCountPerRequest = totalBlockCountToFetch;
      }
      const stats = await this.client.getFeeHistory({
        blockCount: Number(blockCountPerRequest),
        blockNumber: latestBlockToRequest,
        rewardPercentiles: [],
      });
      // NOTE: `baseFeePerGas` includes the next block after the newest of the returned range,
      // so we need to exclude it
      stats.baseFeePerGas.pop();
      newGasFees = [...stats.baseFeePerGas, ...newGasFees];
      latestBlockToRequest -= blockCountPerRequest;
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
