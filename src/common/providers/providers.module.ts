import { FallbackProviderModule, NonEmptyArray } from '@lido-nestjs/execution';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { Keysapi } from './keysapi/keysapi';
import { ConfigService } from '../config/config.service';
import { WorkingMode } from '../config/env.validation';
import { PrometheusService, RequestStatus } from '../prometheus';
import { UtilsModule } from '../utils/utils.module';

const ExecutionDaemon = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService, prometheusService: PrometheusService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('CHAIN_ID'),
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
    inject: [ConfigService, PrometheusService],
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
  providers: [Execution, Consensus, Keysapi],
  exports: [Execution, Consensus, Keysapi],
})
export class ProvidersModule {}
