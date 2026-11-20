import { type PublicClient, createPublicClient, defineChain, fallback, http } from 'viem';

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

function elTransport(url: string, config: ConfigService, logger: AppLogger, prometheus?: PrometheusService) {
  const hostname = new URL(url).hostname;
  const name = 'batch';
  const target = hostname;
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
      const stop = prometheus?.outgoingELRequestsDuration.startTimer({ name, target });
      try {
        const response = await fetch(input, init);
        const status = response.ok ? RequestStatus.COMPLETE : RequestStatus.ERROR;
        prometheus?.outgoingELRequestsCount.inc({ name, target, status });
        void logErrorResponse(response, hostname, traceHeaders, logger);
        return response;
      } catch (e) {
        prometheus?.outgoingELRequestsCount.inc({ name, target, status: RequestStatus.ERROR });
        throw e;
      } finally {
        stop?.();
      }
    },
  });
}

export async function checkElChainIds(
  config: ConfigService,
  logger: AppLogger,
  prometheus?: PrometheusService,
): Promise<void> {
  await Promise.all(
    config.get('EL_RPC_URLS').map(async (url) => {
      const hostname = new URL(url).hostname;
      let chainId: number;
      try {
        chainId = Number(await elTransport(url, config, logger, prometheus)({}).request({ method: 'eth_chainId' }));
      } catch {
        logger.warn(`EL ${hostname} is unreachable, its chain id is not checked`);
        return;
      }
      if (chainId !== config.get('CHAIN_ID')) {
        throw new Error(`EL ${hostname} reports chain id ${chainId}, CHAIN_ID is ${config.get('CHAIN_ID')}`);
      }
    }),
  );
}

export function createElClient(config: ConfigService, logger: AppLogger, prometheus?: PrometheusService): PublicClient {
  const urls = config.get('EL_RPC_URLS');
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
      fallback(
        urls.map((url) => elTransport(url, config, logger, prometheus)),
        { retryCount: 0 },
      ),
    ),
    batch: { multicall: { batchSize: BATCH_SIZE_BYTES } },
  });
}
