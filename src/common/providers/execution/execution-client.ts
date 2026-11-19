import { type PublicClient, type Transport, createPublicClient, defineChain, fallback, http } from 'viem';

import { instrumentedFetch, logTracedErrors } from './http-observability.js';
import { MULTICALL3_ADDRESS, sequentialMulticall } from './sequential-multicall.js';
import type { ConfigService } from '../../config/config.service.js';
import { userAgentHeaders } from '../../helpers/user-agent.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { type PrometheusService } from '../../prometheus/index.js';

export const EL_CLIENT = 'EL_CLIENT';

// Calldata bytes per aggregate3; keeps our heaviest batches near 10M gas, a margin below the eth_call gas cap
const BATCH_SIZE_BYTES = 17_000;

type ElChain = ReturnType<typeof elChain>;
type ElEndpoint = { hostname: string; transport: Transport };

function elChain(config: ConfigService) {
  return defineChain({
    id: config.get('CHAIN_ID'),
    name: `Chain ${config.get('CHAIN_ID')}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: config.get('EL_RPC_URLS') } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
}

function elEndpoint(url: string, config: ConfigService, logger: AppLogger, prometheus?: PrometheusService): ElEndpoint {
  const hostname = new URL(url).hostname;
  const transport = http(url, {
    batch: {
      batchSize: config.get('EL_RPC_MAX_BATCH_SIZE'),
      wait: config.get('EL_RPC_BATCH_AGGREGATION_WAIT_MS'),
    },
    retryCount: config.get('EL_RPC_MAX_RETRIES'),
    retryDelay: config.get('EL_RPC_RETRY_DELAY_MS'),
    fetchOptions: { headers: userAgentHeaders(config) },
    fetchFn: prometheus && instrumentedFetch(hostname, prometheus),
    onFetchResponse: logTracedErrors(hostname, logger),
  });
  return { hostname, transport };
}

async function checkChainId({ hostname, transport }: ElEndpoint, chain: ElChain, logger: AppLogger): Promise<void> {
  let chainId: number;
  try {
    chainId = Number(await transport({ chain }).request({ method: 'eth_chainId' }));
  } catch {
    logger.warn(`EL ${hostname} is unreachable, its chain id is not checked`);
    return;
  }
  if (chainId !== chain.id) {
    throw new Error(`EL ${hostname} reports chain id ${chainId}, CHAIN_ID is ${chain.id}`);
  }
}

export async function createElClient(
  config: ConfigService,
  logger: AppLogger,
  prometheus?: PrometheusService,
): Promise<PublicClient> {
  const chain = elChain(config);
  const endpoints = config.get('EL_RPC_URLS').map((url) => elEndpoint(url, config, logger, prometheus));

  await Promise.all(endpoints.map((endpoint) => checkChainId(endpoint, chain, logger)));

  return createPublicClient({
    chain,
    ccipRead: false,
    transport: sequentialMulticall(
      fallback(
        endpoints.map(({ transport }) => transport),
        { rank: false, retryCount: 0 },
      ),
      logger,
    ),
    batch: { multicall: { batchSize: BATCH_SIZE_BYTES } },
  });
}
