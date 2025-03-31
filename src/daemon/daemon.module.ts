import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service';
import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import { RootsStack } from './services/roots-stack';
import { ConfigModule } from '../common/config/config.module';
import { ContractsModule } from '../common/contracts/contracts.module';
import { HealthModule } from '../common/health/health.module';
import { LoggerModule } from '../common/logger/logger.module';
import { PrometheusModule } from '../common/prometheus/prometheus.module';
import { ProverModule } from '../common/prover/prover.module';
import { ProvidersModule } from '../common/providers/providers.module';
import { WorkersModule } from '../common/workers/workers.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule,
    HealthModule,
    PrometheusModule,
    ProvidersModule,
    WorkersModule,
    ProverModule,
    ContractsModule,
  ],
  providers: [DaemonService, KeysIndexer, RootsProvider, RootsProcessor, RootsStack],
  exports: [DaemonService],
})
export class DaemonModule {}
