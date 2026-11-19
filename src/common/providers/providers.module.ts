import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { Consensus } from './consensus/consensus.js';
import { DownloadProgressModule } from './consensus/download-progress.module.js';
import { checkElChainIds } from './execution/execution-client.js';
import { Execution } from './execution/execution.js';
import { Ipfs } from './ipfs/ipfs.js';
import { ConfigService } from '../config/config.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { PrometheusService } from '../prometheus/index.js';

// Providers that inject Execution read the EL as they are created, so the chain id is checked before Execution exists
const ExecutionProvider = {
  provide: Execution,
  useFactory: async (
    config: ConfigService,
    logger: AppLogger,
    moduleRef: ModuleRef,
    prometheus?: PrometheusService,
  ): Promise<Execution> => {
    await checkElChainIds(config, logger, prometheus);
    return moduleRef.create(Execution);
  },
  inject: [ConfigService, LOGGER_PROVIDER, ModuleRef, { token: PrometheusService, optional: true }],
};

@Module({
  imports: [
    ConditionalModule.registerWhen(DownloadProgressModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [ExecutionProvider, Consensus, Ipfs],
  exports: [Execution, Consensus, Ipfs],
})
export class ProvidersModule {}
