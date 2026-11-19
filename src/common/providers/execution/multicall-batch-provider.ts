import { AllProvidersFailedError, type BlockTag, SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { utils } from 'ethers';

import { type Multicall3, Multicall3__factory } from '../../contracts/types/index.js';

// Same address on mainnet and Hoodi
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Calldata bytes per aggregate3; keeps our heaviest batches near 10M gas, a margin below the eth_call gas cap
const BATCH_SIZE_BYTES = 17_000;

type CallParams = { transaction: { to?: string; data?: string }; blockTag: BlockTag };

type CallException = { code?: string; error?: { code?: number | string; message?: string } };

type NodeError = { code?: number | string; message?: string; reason?: string; status?: number };

type PendingCall = {
  to: string;
  data: string;
  resolve: (returnData: string) => void;
  reject: (error: unknown) => void;
};

// Ports viem's batch.multicall to ethers v5; drop it in favour of viem when the EL layer moves there.
// Plain reads ({to, data}) started in the same tick for the same block are sent as Multicall3.aggregate3,
// cut by calldata size and sent one after another; each read gets its own result or revert.
// Only calls started in the same tick are batched; reads awaited one by one go out as separate aggregate3 calls
export class MulticallBatchProvider extends SimpleFallbackJsonRpcBatchProvider {
  private multicall: Multicall3 = Multicall3__factory.connect(MULTICALL3_ADDRESS, this);
  private queues = new Map<string, PendingCall[]>();

  // Overrides lido's perform: plain eth_calls are batched, every other request goes to its fallback as before
  public override async perform(method: string, params: { [name: string]: unknown }): Promise<unknown> {
    if (method !== 'call') return super.perform(method, params);

    const {
      transaction: { to, data, ...rest },
      blockTag,
    } = params as CallParams;
    // Not batched: aggregate3 itself (it would loop back here) and calls with from/value/gas (msg.sender would become Multicall3)
    if (
      typeof blockTag !== 'string' ||
      !to ||
      !data ||
      Object.values(rest).some((value) => value != null) ||
      to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()
    )
      return super.perform(method, params);

    return this.enqueue(to, data, blockTag);
  }

  // Overrides lido's retry check, which never retries a failed eth_call: only a revert stays final, other failures are retried and then go to the next URL
  protected override isNonRetryableError(error: unknown): boolean {
    const { code, error: nested } = (error ?? {}) as CallException;
    if (code !== 'CALL_EXCEPTION') return super.isNonRetryableError(error);

    // No numeric JSON-RPC code means the node never answered (HTTP error, timeout, broken batch), so retry
    if (typeof nested?.code !== 'number') return false;
    // ethers reports any failed eth_call as CALL_EXCEPTION; only a node's JSON-RPC error that says revert (or code 3) is final
    const isRevert = nested.code === 3 || (nested.message ?? '').toLowerCase().includes('revert');
    return isRevert && super.isNonRetryableError(error);
  }

  private enqueue(to: string, data: string, blockTag: string): Promise<string> {
    const queue = this.queues.get(blockTag) ?? [];
    if (!queue.length) {
      this.queues.set(blockTag, queue);
      setTimeout(() => void this.flush(blockTag), 0);
    }
    return new Promise<string>((resolve, reject) => queue.push({ to, data, resolve, reject }));
  }

  private async flush(blockTag: string): Promise<void> {
    const calls = this.queues.get(blockTag) ?? [];
    this.queues.delete(blockTag);

    const batches = this.splitBySize(calls);
    for (const [i, batch] of batches.entries()) {
      try {
        await this.sendBatch(batch, blockTag);
      } catch (e) {
        const cause = e instanceof AllProvidersFailedError ? e.cause : e;
        const { code, message, reason, status } = ((cause as CallException)?.error ?? cause ?? {}) as NodeError;
        // The node's reason instead of an error carrying the whole aggregate3 calldata
        const error = new Error(
          `EL read at block ${blockTag} failed: ${JSON.stringify({ code, message: reason ?? message, status })}`,
          { cause: e },
        );
        batches.slice(i).forEach((rest) => rest.forEach(({ reject }) => reject(error)));
        return;
      }
    }
  }

  private splitBySize(calls: PendingCall[]): PendingCall[][] {
    const batches: PendingCall[][] = [];
    let batchBytes = 0;
    for (const call of calls) {
      const callBytes = utils.hexDataLength(call.data);
      if (batches.length === 0 || batchBytes + callBytes > BATCH_SIZE_BYTES) {
        batches.push([]);
        batchBytes = 0;
      }
      batches[batches.length - 1].push(call);
      batchBytes += callBytes;
    }
    return batches;
  }

  private async sendBatch(batch: PendingCall[], blockTag: string): Promise<void> {
    const results = await this.multicall.callStatic.aggregate3(
      batch.map(({ to, data }) => ({ target: to, callData: data, allowFailure: true })),
      { blockTag },
    );
    batch.forEach((call, i) => this.settle(call, results[i], blockTag));
  }

  private settle(
    { to, data, resolve, reject }: PendingCall,
    [success, returnData]: Multicall3.ResultStructOutput,
    blockTag: string,
  ): void {
    // Which call of the batch reverted, ready to replay
    if (!success)
      this.logger.warn(`EL call reverted at block ${blockTag}: ${JSON.stringify({ to, data, revert: returnData })}`);
    // Revert data without a selector could decode as a valid result, so only selector-prefixed data goes back to ethers to decode
    if (success || utils.hexDataLength(returnData) % 32 === 4) return resolve(returnData);
    reject(
      Object.assign(new Error('call reverted without decodable revert data'), {
        code: utils.Logger.errors.CALL_EXCEPTION,
        data: returnData,
        transaction: { to, data },
      }),
    );
  }
}
