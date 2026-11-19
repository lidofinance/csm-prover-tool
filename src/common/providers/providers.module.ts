import { type NonEmptyArray, type SimpleFallbackProviderConfig } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { type utils } from 'ethers';

import { Consensus } from './consensus/consensus.js';
import { DownloadProgressModule } from './consensus/download-progress.module.js';
import { Execution } from './execution/execution.js';
import { MulticallBatchProvider } from './execution/multicall-batch-provider.js';
import { Ipfs } from './ipfs/ipfs.js';
import { ConfigService } from '../config/config.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { userAgentHeaders } from '../helpers/user-agent.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { PrometheusService, RequestStatus } from '../prometheus/index.js';

// ethers sends no User-Agent for a plain URL string, so pass ConnectionInfo instead.
function elUrls(config: ConfigService): NonEmptyArray<utils.ConnectionInfo> {
  const headers = userAgentHeaders(config);
  const conn = (url: string): utils.ConnectionInfo => ({ url, headers });
  const [first, ...rest] = config.get('EL_RPC_URLS') as NonEmptyArray<string>;
  return [conn(first), ...rest.map(conn)];
}

function elOptions(configService: ConfigService, prometheusService?: PrometheusService): SimpleFallbackProviderConfig {
  return {
    urls: elUrls(configService),
    network: configService.get('CHAIN_ID'),
    maxRetries: configService.get('EL_RPC_MAX_RETRIES'),
    minBackoffMs: configService.get('EL_RPC_RETRY_DELAY_MS'),
    resetIntervalMs: configService.get('EL_RPC_RESET_INTERVAL_MS'),
    requestPolicy: {
      jsonRpcMaxBatchSize: configService.get('EL_RPC_MAX_BATCH_SIZE'),
      maxConcurrentRequests: configService.get('EL_RPC_MAX_CONCURRENT_REQUESTS'),
      batchAggregationWaitMs: configService.get('EL_RPC_BATCH_AGGREGATION_WAIT_MS'),
    },
    logSuccessfulAttempts: false,
    logRetries: false,
    fetchMiddlewares: prometheusService && [
      async (next, ctx) => {
        const targetName = new URL(ctx.provider.connection.url).hostname;
        const reqName = 'batch';
        const stop = prometheusService.outgoingELRequestsDuration.startTimer({
          name: reqName,
          target: targetName,
        });
        return await next()
          .then((r: any) => {
            prometheusService.outgoingELRequestsCount.inc({
              name: reqName,
              target: targetName,
              status: RequestStatus.COMPLETE,
            });
            return r;
          })
          .catch((e: any) => {
            prometheusService.outgoingELRequestsCount.inc({
              name: reqName,
              target: targetName,
              status: RequestStatus.ERROR,
            });
            throw e;
          })
          .finally(() => stop());
      },
    ],
  };
}

@Module({
  imports: [
    ConditionalModule.registerWhen(DownloadProgressModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [
    {
      provide: MulticallBatchProvider,
      useFactory: (config: ConfigService, logger: AppLogger, prometheus?: PrometheusService) =>
        new MulticallBatchProvider(elOptions(config, prometheus), logger),
      inject: [ConfigService, LOGGER_PROVIDER, { token: PrometheusService, optional: true }],
    },
    Execution,
    Consensus,
    Ipfs,
  ],
  exports: [Execution, Consensus, Ipfs],
})
export class ProvidersModule {}
