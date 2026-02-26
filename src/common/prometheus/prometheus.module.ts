import { Global, Module } from '@nestjs/common';
import { PrometheusModule as PrometheusModuleSource } from '@willsoto/nestjs-prometheus';

import { METRICS_PREFIX, METRICS_URL } from './prometheus.constants.js';
import { PrometheusController } from './prometheus.controller.js';
import { PrometheusService } from './prometheus.service.js';

@Global()
@Module({
  imports: [
    PrometheusModuleSource.register({
      controller: PrometheusController,
      path: METRICS_URL,
      defaultMetrics: {
        enabled: true,
        config: { prefix: METRICS_PREFIX },
      },
    }),
  ],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
