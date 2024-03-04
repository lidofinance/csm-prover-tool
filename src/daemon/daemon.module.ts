import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service';
import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import { RootsStack } from './services/roots-stack';
import { ConfigModule } from '../common/config/config.module';
import { HandlersModule } from '../common/handlers/handlers.module';
import { LoggerModule } from '../common/logger/logger.module';
import { PrometheusModule } from '../common/prometheus/prometheus.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, PrometheusModule, ProvidersModule, HandlersModule],
  providers: [DaemonService, KeysIndexer, RootsProvider, RootsProcessor, RootsStack],
  exports: [DaemonService],
})
export class DaemonModule {}
