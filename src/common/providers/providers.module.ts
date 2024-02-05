import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { Consensus } from './consensus/consensus';
import { Execution } from './execution/execution';
import { Keysapi } from './keysapi/keysapi';
import { WorkingMode } from '../config/env.validation';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { UtilsModule } from '../utils/utils.module';

@Module({
  imports: [
    ConditionalModule.registerWhen(PrometheusModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
    UtilsModule,
  ],
  providers: [Execution, Consensus, Keysapi],
  exports: [Execution, Consensus, Keysapi],
})
export class ProvidersModule {}
