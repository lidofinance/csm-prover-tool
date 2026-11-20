import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus.js';
import { DownloadProgressModule } from './consensus/download-progress.module.js';
import { EL_CLIENT, createElClient } from './execution/execution-client.js';
import { Execution } from './execution/execution.js';
import { Ipfs } from './ipfs/ipfs.js';
import { ConfigService } from '../config/config.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { PrometheusService } from '../prometheus/index.js';

@Module({
  imports: [
    ConditionalModule.registerWhen(DownloadProgressModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.CLI;
    }),
  ],
  providers: [
    {
      provide: EL_CLIENT,
      useFactory: createElClient,
      inject: [ConfigService, LOGGER_PROVIDER, { token: PrometheusService, optional: true }],
    },
    Execution,
    Consensus,
    Ipfs,
  ],
  exports: [Execution, Consensus, Ipfs],
})
export class ProvidersModule {}
