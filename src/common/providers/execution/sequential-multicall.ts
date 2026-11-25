import type { EIP1193RequestFn, EIP1193RequestOptions, Transport } from 'viem';

// Same address on mainnet and Hoodi
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

type CallArgs = { method: string; params?: unknown };

type PendingCall = {
  args: CallArgs;
  options?: EIP1193RequestOptions;
  blockTag: unknown;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

type ReadError = Partial<Record<'code' | 'status' | 'details' | 'shortMessage' | 'message', unknown>>;

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
          const { code, status, details, shortMessage, message }: ReadError = e instanceof Error ? e : {};
          // The node's reason instead of an error carrying the whole aggregate3 calldata
          const error = new Error(
            `EL read at block ${call.blockTag} failed: ${JSON.stringify({ code, message: details ?? shortMessage ?? message, status })}`,
            { cause: e },
          );
          call.reject(error);
          queue.splice(0).forEach(({ reject }) => reject(error));
        }
      }
      isDraining = false;
    };

    const request: EIP1193RequestFn = (args, options) => {
      const [call, blockTag] = Array.isArray(args.params) ? args.params : [];
      if (args.method !== 'eth_call' || call?.to !== MULTICALL3_ADDRESS) {
        return transport.request(args, options);
      }
      return new Promise((resolve, reject) => {
        queue.push({ args, options, blockTag, resolve, reject });
        if (!isDraining) void drain();
      });
    };

    return { ...transport, request };
  };
}
