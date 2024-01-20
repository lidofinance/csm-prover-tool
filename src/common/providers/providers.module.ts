import { Module } from '@nestjs/common';

import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { Keysapi } from './keysapi/keysapi';
import { ConditionalModule } from '@nestjs/config';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { WorkingMode } from '../config/env.validation';

@Module({
  imports: [
    ConditionalModule.registerWhen(PrometheusModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
  ],
  providers: [Execution, Consensus, Keysapi],
  exports: [Execution, Consensus, Keysapi],
})
export class ProvidersModule {}
