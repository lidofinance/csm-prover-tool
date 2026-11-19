import {
  BaseError,
  type EIP1193RequestFn,
  type EIP1193RequestOptions,
  type Hex,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  type Transport,
  decodeFunctionData,
  decodeFunctionResult,
  multicall3Abi,
} from 'viem';

import { type AppLogger } from '../../logger/app-logger.type.js';

// Same address on mainnet and Hoodi
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

type CallArgs = { method: string; params?: unknown };

type PendingCall = {
  args: CallArgs;
  options?: EIP1193RequestOptions;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

function ethCallParams({ params }: CallArgs): { to?: string; data: Hex; blockTag: string } {
  const [{ to, data }, blockTag] = params as [{ to?: string; data: Hex }, string];
  return { to, data, blockTag };
}

// One Multicall3 eth_call at a time to stay within node rate limits; a failure rejects the queued ones unsent
export function sequentialMulticall(inner: Transport, logger: AppLogger): Transport {
  const multicallAddress = MULTICALL3_ADDRESS.toLowerCase();
  return (parameters) => {
    const transport = inner(parameters);
    const queue: PendingCall[] = [];
    let isDraining = false;

    const drain = async () => {
      isDraining = true;
      for (let call = queue.shift(); call; call = queue.shift()) {
        try {
          const result = await transport.request(call.args, call.options);
          logReverts(call.args, result, logger);
          call.resolve(result);
        } catch (e) {
          const error = toElReadError(call.args, e);
          call.reject(error);
          queue.splice(0).forEach(({ reject }) => reject(error));
        }
      }
      isDraining = false;
    };

    const request = (args: CallArgs, options?: EIP1193RequestOptions) => {
      const [call] = (args.params ?? []) as [{ to?: string }?];
      if (args.method !== 'eth_call' || call?.to?.toLowerCase() !== multicallAddress) {
        return transport.request(args, options);
      }
      return new Promise((resolve, reject) => {
        queue.push({ args, options, resolve, reject });
        if (!isDraining) void drain();
      });
    };

    return { ...transport, request: request as EIP1193RequestFn };
  };
}

// The node's reason instead of an error carrying the whole aggregate3 calldata
function toElReadError(args: CallArgs, cause: unknown): Error {
  const { blockTag } = ethCallParams(args);
  const node = (
    cause instanceof BaseError
      ? cause.walk((e) => e instanceof RpcRequestError || e instanceof HttpRequestError || e instanceof TimeoutError)
      : null
  ) as Partial<RpcRequestError> | null;
  const message = node?.details ?? (cause instanceof BaseError ? cause.shortMessage : (cause as Error).message);
  return new Error(
    `EL read at block ${blockTag} failed: ${JSON.stringify({ code: node?.code, message, status: node?.status })}`,
    { cause },
  );
}

// Which call of the batch reverted, ready to replay
function logReverts(args: CallArgs, result: unknown, logger: AppLogger): void {
  const { data, blockTag } = ethCallParams(args);
  try {
    const request = decodeFunctionData({ abi: multicall3Abi, data });
    if (request.functionName !== 'aggregate3') return;
    const calls = request.args[0];
    const results = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      data: result as `0x${string}`,
    });
    results.forEach(({ success, returnData }, i) => {
      if (success) return;
      const { target, callData } = calls[i];
      logger.warn(
        `EL call reverted at block ${blockTag}: ${JSON.stringify({ to: target, data: callData, revert: returnData })}`,
      );
    });
  } catch {
    // viem decodes the same bytes for the callers and reports a malformed result there
  }
}
