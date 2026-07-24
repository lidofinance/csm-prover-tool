import { Module } from '@nestjs/common';

import { DaemonService } from './daemon.service.js';
import { KeysIndexer } from './services/keys-indexer.js';
import { RootsProcessor } from './services/roots-processor.js';
import { RootsProvider } from './services/roots-provider.js';
import { RootsStack } from './services/roots-stack.js';
import { ConfigModule } from '../common/config/config.module.js';
import { HealthModule } from '../common/health/health.module.js';
import { LoggerModule } from '../common/logger/logger.module.js';
import { PrometheusModule } from '../common/prometheus/index.js';
import { ProverModule } from '../common/prover/prover.module.js';
import { ProvidersModule } from '../common/providers/providers.module.js';
import { WorkersModule } from '../common/workers/workers.module.js';

@Module({
  imports: [LoggerModule, ConfigModule, HealthModule, PrometheusModule, ProvidersModule, WorkersModule, ProverModule],
  providers: [DaemonService, KeysIndexer, RootsProvider, RootsProcessor, RootsStack],
  exports: [DaemonService],
})
export class DaemonModule {}
