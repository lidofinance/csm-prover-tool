import {
  BaseError,
  ContractFunctionRevertedError,
  type EIP1193RequestFn,
  HttpRequestError,
  type PublicClient,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  type Transport,
  createPublicClient,
  decodeFunctionData,
  decodeFunctionResult,
  defineChain,
  fallback,
  http,
  multicall3Abi,
} from 'viem';

import type { ConfigService } from '../../config/config.service.js';
import { userAgentHeaders } from '../../helpers/user-agent.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { type PrometheusService, RequestStatus } from '../../prometheus/index.js';

export const EL_CLIENT = 'EL_CLIENT';

// Same address on mainnet and Hoodi
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Calldata bytes per aggregate3; keeps our heaviest batches near 10M gas, a margin below the eth_call gas cap
const BATCH_SIZE_BYTES = 17_000;

type CallArgs = { method: string; params?: unknown };

type PendingCall = {
  args: CallArgs;
  options: unknown;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

function instrumentedFetch(url: string, prometheus: PrometheusService): typeof fetch {
  const target = new URL(url).hostname;
  const name = 'batch';
  return async (input, init) => {
    const stop = prometheus.outgoingELRequestsDuration.startTimer({ name, target });
    try {
      const response = await fetch(input, init);
      const status = response.ok ? RequestStatus.COMPLETE : RequestStatus.ERROR;
      prometheus.outgoingELRequestsCount.inc({ name, target, status });
      return response;
    } catch (e) {
      prometheus.outgoingELRequestsCount.inc({ name, target, status: RequestStatus.ERROR });
      throw e;
    } finally {
      stop();
    }
  };
}

const TRACE_HEADERS = ['x-drpc-trace-id', 'cf-ray'];

// Trace ids let a provider find the request behind an error, even one fallback recovered from; viem awaits the hook, so it must not block
function logTracedErrors(hostname: string, logger: AppLogger): (response: Response) => void {
  return (response) => {
    const ids = TRACE_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [`${name}: ${value}`] : [];
    }).join(', ');
    if (!ids) return;
    if (!response.ok) {
      logger.warn(`EL ${hostname} answered HTTP ${response.status} (${ids})`);
      return;
    }
    try {
      void response
        .clone()
        .text()
        .then((text) => {
          if (!text.includes('"error"')) return;
          const parsed = JSON.parse(text);
          for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
            if (!item?.error) continue;
            const { code, message } = item.error;
            logger.warn(`EL ${hostname} returned error ${JSON.stringify({ code, message })} (${ids})`);
          }
        })
        .catch(() => {});
    } catch {
      // a trace log must never change the outcome of the request
    }
  };
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
          const result = await transport.request(call.args as never, call.options as never);
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

    const request = (args: CallArgs, options: unknown) => {
      const [call] = (args.params ?? []) as [{ to?: string }?];
      if (args.method !== 'eth_call' || call?.to?.toLowerCase() !== multicallAddress) {
        return transport.request(args as never, options as never);
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
function logReverts({ params }: CallArgs, result: unknown, logger: AppLogger): void {
  const [{ data }, blockTag] = params as [{ data: `0x${string}` }, string];
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

// viem words a node error on the aggregate itself as a revert too, so only a subcall's RawContractError counts
export function findContractRevert(e: unknown): ContractFunctionRevertedError | undefined {
  if (!(e instanceof BaseError) || !e.walk((err) => err instanceof RawContractError)) return undefined;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert : undefined;
}

export async function createElClient(
  config: ConfigService,
  logger: AppLogger,
  prometheus?: PrometheusService,
): Promise<PublicClient> {
  const urls = config.get('EL_RPC_URLS');
  const chain = defineChain({
    id: config.get('CHAIN_ID'),
    name: `Chain ${config.get('CHAIN_ID')}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
  const transports = urls.map((url) =>
    http(url, {
      batch: {
        batchSize: config.get('EL_RPC_MAX_BATCH_SIZE'),
        wait: config.get('EL_RPC_BATCH_AGGREGATION_WAIT_MS'),
      },
      retryCount: config.get('EL_RPC_MAX_RETRIES'),
      retryDelay: config.get('EL_RPC_RETRY_DELAY_MS'),
      fetchOptions: { headers: userAgentHeaders(config) },
      fetchFn: prometheus && instrumentedFetch(url, prometheus),
      onFetchResponse: logTracedErrors(new URL(url).hostname, logger),
    }),
  );

  await Promise.all(
    urls.map(async (url, i) => {
      const hostname = new URL(url).hostname;
      let chainId: number;
      try {
        chainId = Number(await transports[i]({ chain }).request({ method: 'eth_chainId' }));
      } catch {
        logger.warn(`EL ${hostname} is unreachable, its chain id is not checked`);
        return;
      }
      if (chainId !== chain.id) {
        throw new Error(`EL ${hostname} reports chain id ${chainId}, CHAIN_ID is ${chain.id}`);
      }
    }),
  );

  return createPublicClient({
    chain,
    ccipRead: false,
    transport: sequentialMulticall(fallback(transports, { rank: false, retryCount: 0 }), logger),
    batch: { multicall: { batchSize: BATCH_SIZE_BYTES } },
  });
}
