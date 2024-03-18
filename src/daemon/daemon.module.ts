import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service';
import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import { RootsStack } from './services/roots-stack';
import { ConfigModule } from '../common/config/config.module';
import { LoggerModule } from '../common/logger/logger.module';
import { PrometheusModule } from '../common/prometheus/prometheus.module';
import { ProverModule } from '../common/prover/prover.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, PrometheusModule, ProvidersModule, ProverModule],
  providers: [DaemonService, KeysIndexer, RootsProvider, RootsProcessor, RootsStack],
  exports: [DaemonService],
})
export class DaemonModule {}
