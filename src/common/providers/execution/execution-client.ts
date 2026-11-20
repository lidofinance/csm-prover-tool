import {
  type Chain,
  type EIP1193RequestFn,
  type PublicClient,
  type Transport,
  createPublicClient,
  createTransport,
  defineChain,
  http,
  shouldThrow,
} from 'viem';

import { MULTICALL3_ADDRESS, sequentialMulticall } from './sequential-multicall.js';
import type { ConfigService } from '../../config/config.service.js';
import { userAgentHeaders } from '../../helpers/user-agent.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { type PrometheusService, RequestStatus } from '../../prometheus/index.js';

// Calldata bytes per aggregate3; keeps our heaviest batches near 10M gas, a margin below the eth_call gas cap
const BATCH_SIZE_BYTES = 17_000;

// Trace ids let a provider find the request behind an error, even one fallback recovered from; viem awaits the fetch, so it must not block
async function logErrorResponse(
  response: Response,
  hostname: string,
  traceHeaders: string[],
  logger: AppLogger,
): Promise<void> {
  try {
    const ids = traceHeaders
      .flatMap((name) => {
        const value = response.headers.get(name);
        return value ? [`${name}: ${value}`] : [];
      })
      .join(', ');
    const suffix = ids ? ` (${ids})` : '';
    if (!response.ok) {
      logger.warn(`EL ${hostname} answered HTTP ${response.status}${suffix}`);
      return;
    }
    const text = await response.clone().text();
    if (!text.includes('"error"')) return;
    const parsed = JSON.parse(text);
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!item?.error) continue;
      const { code, message } = item.error;
      logger.warn(`EL ${hostname} returned error ${JSON.stringify({ code, message })}${suffix}`);
    }
  } catch {
    // a trace log must never change the outcome of the request
  }
}

// undici wraps the socket error code in `cause` and a viem timeout aborts the request signal
function describeFetchError(e: unknown, init?: RequestInit): string {
  if (init?.signal?.aborted) return 'timeout';
  if (!(e instanceof Error)) return String(e);
  const { cause } = e;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : e.message;
}

function elTransport(url: string, config: ConfigService, logger: AppLogger, prometheus?: PrometheusService) {
  const hostname = new URL(url).hostname;
  const labels = { name: 'batch', target: hostname };
  const traceHeaders = config.get('EL_TRACE_HEADERS');
  return http(url, {
    batch: {
      batchSize: config.get('EL_RPC_MAX_BATCH_SIZE'),
      wait: config.get('EL_RPC_BATCH_AGGREGATION_WAIT_MS'),
    },
    retryCount: config.get('EL_RPC_MAX_RETRIES'),
    retryDelay: config.get('EL_RPC_RETRY_DELAY_MS'),
    fetchOptions: { headers: userAgentHeaders(config) },
    fetchFn: async (input, init) => {
      const stop = prometheus?.outgoingELRequestsDuration.startTimer(labels);
      let status = RequestStatus.ERROR;
      try {
        const response = await fetch(input, init);
        if (response.ok) status = RequestStatus.COMPLETE;
        void logErrorResponse(response, hostname, traceHeaders, logger);
        return response;
      } catch (e) {
        logger.warn(`EL ${hostname} request failed: ${describeFetchError(e, init)}`);
        throw e;
      } finally {
        prometheus?.outgoingELRequestsCount.inc({ ...labels, status });
        stop?.();
      }
    },
  });
}

// viem's fallback retries the first URL on every request and its rank mode pings forever; go back to it only after EL_RPC_RESET_INTERVAL_MS
function stickyFailover(transports: Transport[], hostnames: string[], resetMs: number, logger: AppLogger): Transport {
  return (parameters) => {
    const instances = transports.map((transport) => transport(parameters));
    let active = 0;
    let switchedAt = 0;
    const request: EIP1193RequestFn = async (args, options) => {
      if (active !== 0 && Date.now() - switchedAt >= resetMs) active = 0;
      const first = active;
      for (let attempt = 0; ; attempt++) {
        const i = (first + attempt) % instances.length;
        try {
          return await instances[i].request(args, options);
        } catch (e) {
          if (!(e instanceof Error) || shouldThrow(e)) throw e;
          const next = (i + 1) % instances.length;
          active = next;
          switchedAt = Date.now();
          if (attempt === instances.length - 1) throw e;
          const reason = 'shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message;
          logger.warn(`EL ${hostnames[i]} failed, trying ${hostnames[next]}: ${reason}`);
        }
      }
    };
    return createTransport({
      key: 'stickyFailover',
      name: 'Sticky failover',
      type: 'stickyFailover',
      retryCount: 0,
      request,
    });
  };
}

export const EL_CLIENT = Symbol('EL_CLIENT');

export async function createElClient(
  config: ConfigService,
  logger: AppLogger,
  prometheus?: PrometheusService,
): Promise<PublicClient<Transport, Chain>> {
  const urls = config.get('EL_RPC_URLS');
  const hostnames = urls.map((url) => new URL(url).hostname);
  const transports = urls.map((url) => elTransport(url, config, logger, prometheus));
  await Promise.all(
    urls.map(async (url, i) => {
      const hostname = new URL(url).hostname;
      const chainId = await transports[i]({})
        .request({ method: 'eth_chainId' })
        .then(Number, () => undefined);
      if (chainId === undefined) {
        logger.warn(`EL ${hostname} is unreachable, its chain id is not checked`);
      } else if (chainId !== config.get('CHAIN_ID')) {
        throw new Error(`EL ${hostname} reports chain id ${chainId}, CHAIN_ID is ${config.get('CHAIN_ID')}`);
      }
    }),
  );
  return createPublicClient({
    chain: defineChain({
      id: config.get('CHAIN_ID'),
      name: `Chain ${config.get('CHAIN_ID')}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: urls } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    }),
    ccipRead: false,
    transport: sequentialMulticall(
      stickyFailover(transports, hostnames, config.get('EL_RPC_RESET_INTERVAL_MS'), logger),
    ),
    batch: { multicall: { batchSize: BATCH_SIZE_BYTES } },
  });
}
