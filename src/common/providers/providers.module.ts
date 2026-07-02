import { FallbackProviderModule, type NonEmptyArray } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus.js';
import { DownloadProgressModule } from './consensus/download-progress.module.js';
import { Execution } from './execution/execution.js';
import { Ipfs } from './ipfs/ipfs.js';
import { Keysapi } from './keysapi/keysapi.js';
import { ConfigService } from '../config/config.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { PrometheusService, RequestStatus } from '../prometheus/index.js';

const ExecutionDaemon = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService, prometheusService: PrometheusService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
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
        fetchMiddlewares: [
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
    },
    inject: [ConfigService, PrometheusService, LOGGER_PROVIDER],
  }) as DynamicModule;

const ExecutionCli = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('CHAIN_ID'),
        requestPolicy: {
          jsonRpcMaxBatchSize: configService.get('EL_RPC_MAX_BATCH_SIZE'),
          maxConcurrentRequests: configService.get('EL_RPC_MAX_CONCURRENT_REQUESTS'),
          batchAggregationWaitMs: configService.get('EL_RPC_BATCH_AGGREGATION_WAIT_MS'),
        },
      };
    },
    inject: [ConfigService],
  }) as DynamicModule;

@Module({
  imports: [
    ConditionalModule.registerWhen(ExecutionDaemon(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
    ConditionalModule.registerWhen(ExecutionCli(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
    ConditionalModule.registerWhen(DownloadProgressModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [Execution, Consensus, Keysapi, Ipfs],
  exports: [Execution, Consensus, Keysapi, Ipfs],
})
export class ProvidersModule {}
