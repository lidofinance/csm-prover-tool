import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { Consensus } from './consensus/consensus.js';
import { DownloadProgressModule } from './consensus/download-progress.module.js';
import { Execution } from './execution/execution.js';
import { Ipfs } from './ipfs/ipfs.js';
import { WorkingMode } from '../config/env.validation.js';

// Providers that inject Execution read the EL as they are created, so the chain id is checked before Execution is provided
const ExecutionProvider = {
  provide: Execution,
  useFactory: async (moduleRef: ModuleRef): Promise<Execution> => {
    const execution = await moduleRef.create(Execution);
    await execution.init();
    return execution;
  },
  inject: [ModuleRef],
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
