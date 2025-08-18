import { Module } from '@nestjs/common';

import { HealthModule } from '@common/health/health.module';
import { PrometheusModule } from '@common/prometheus/prometheus.module';
import { WorkersModule } from '@common/workers/workers.module';

import { AppSharedModule } from '@app/app-shared.module';

import { DaemonService } from './daemon.service';
import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import { RootsStack } from './services/roots-stack';

@Module({
  imports: [HealthModule, PrometheusModule, WorkersModule, AppSharedModule],
  providers: [DaemonService, KeysIndexer, RootsProvider, RootsProcessor, RootsStack],
  exports: [DaemonService],
})
export class DaemonModule {}
