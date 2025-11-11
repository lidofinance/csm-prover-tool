import { FallbackProviderModule, NonEmptyArray } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { Keysapi } from './keysapi/keysapi';
import { ConfigService } from '../config/config.service';
import { WorkingMode } from '../config/env.validation';
import { PrometheusService, RequestStatus } from '../prometheus';
import { UtilsModule } from '../utils/utils.module';
import { Ipfs } from './ipfs/ipfs';

const ExecutionDaemon = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService, prometheusService: PrometheusService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('CHAIN_ID'),
        maxRetries: configService.get('EL_RPC_MAX_RETRIES'),
        minBackoffMs: configService.get('EL_RPC_RETRY_DELAY_MS'),
        logRetries: true,
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
  });

const ExecutionCli = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('CHAIN_ID'),
      };
    },
    inject: [ConfigService],
  });

@Module({
  imports: [
    ConditionalModule.registerWhen(ExecutionDaemon(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
    ConditionalModule.registerWhen(ExecutionCli(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
    ConditionalModule.registerWhen(UtilsModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [Execution, Consensus, Keysapi, Ipfs],
  exports: [Execution, Consensus, Keysapi, Ipfs],
})
export class ProvidersModule {}
