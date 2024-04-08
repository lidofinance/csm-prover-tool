import { Global, Module } from '@nestjs/common';

import { PrometheusService } from './prometheus.service';

@Global()
@Module({
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
