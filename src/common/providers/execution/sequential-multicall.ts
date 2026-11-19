import type { EIP1193RequestFn, EIP1193RequestOptions, Transport } from 'viem';

// Same address on mainnet and Hoodi
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

type CallArgs = { method: string; params?: unknown };

type PendingCall = {
  args: CallArgs;
  options?: EIP1193RequestOptions;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

// One Multicall3 eth_call at a time to stay within node rate limits; a failure rejects the queued ones unsent
export function sequentialMulticall(inner: Transport): Transport {
  return (parameters) => {
    const transport = inner(parameters);
    const queue: PendingCall[] = [];
    let isDraining = false;

    const drain = async () => {
      isDraining = true;
      for (let call = queue.shift(); call; call = queue.shift()) {
        try {
          const result = await transport.request(call.args, call.options);
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
      if (args.method !== 'eth_call' || call?.to !== MULTICALL3_ADDRESS) {
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
function toElReadError({ params }: CallArgs, cause: unknown): Error {
  const [, blockTag] = params as [unknown, string];
  const { code, status, details, shortMessage, message } = cause as Record<string, unknown>;
  return new Error(
    `EL read at block ${blockTag} failed: ${JSON.stringify({ code, message: details ?? shortMessage ?? message, status })}`,
    { cause },
  );
}
