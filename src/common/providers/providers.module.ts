import { FallbackProviderModule, NonEmptyArray } from '@lido-nestjs/execution';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { Keysapi } from './keysapi/keysapi';
import { ConfigService } from '../config/config.service';
import { WorkingMode } from '../config/env.validation';
import { PrometheusService } from '../prometheus/prometheus.service';
import { UtilsModule } from '../utils/utils.module';

const ExecutionDaemon = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('ETH_NETWORK'),
        // TODO: add prometheus metrics
        // fetchMiddlewares: [ ... ],
      };
    },
    inject: [ConfigService, PrometheusService],
  });

const ExecutionCli = () =>
  FallbackProviderModule.forRootAsync({
    async useFactory(configService: ConfigService) {
      return {
        urls: configService.get('EL_RPC_URLS') as NonEmptyArray<string>,
        network: configService.get('ETH_NETWORK'),
      };
    },
    inject: [ConfigService],
  });

@Module({
  imports: [
    UtilsModule,
    ConditionalModule.registerWhen(ExecutionDaemon(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
    ConditionalModule.registerWhen(ExecutionCli(), (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [Execution, Consensus, Keysapi],
  exports: [Execution, Consensus, Keysapi],
})
export class ProvidersModule {}
