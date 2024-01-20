import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service';
import { ConfigModule } from '../common/config/config.module';
import { HandlersModule } from '../common/handlers/handlers.module';
import { LoggerModule } from '../common/logger/logger.module';
import { PrometheusModule } from '../common/prometheus/prometheus.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule,
    PrometheusModule,
    ProvidersModule,
    HandlersModule,
  ],
  providers: [DaemonService],
})
export class DaemonModule {}
