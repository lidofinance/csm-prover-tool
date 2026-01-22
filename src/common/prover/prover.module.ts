import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { ConsolidationCacheStoreModule } from './cache/consolidation-cache-store.module';
import { SlashingsService } from './duties/slashings.service';
import { WithdrawalsService } from './duties/withdrawals.service';
import { ProverService } from './prover.service';
import { WorkingMode } from '../config/env.validation';
import { ContractsModule } from '../contracts/contracts.module';
import { ProvidersModule } from '../providers/providers.module';
import { WorkersModule } from '../workers/workers.module';
import { BadPerformersService } from './duties/bad-performers.service';
import { ConsolidationCacheManager } from './duties/consolidations/consolidation-cache-manager';
import { ConsolidationProofContextResolver } from './duties/consolidations/consolidation-proof-context';
import { ConsolidationProofSender } from './duties/consolidations/consolidation-proof-sender';
import { ConsolidationsService } from './duties/consolidations.service';

@Module({
  imports: [
    ProvidersModule,
    ContractsModule,
    WorkersModule,
    ConditionalModule.registerWhen(ConsolidationCacheStoreModule, (env: NodeJS.ProcessEnv) => {
      return env['WORKING_MODE'] === WorkingMode.Daemon;
    }),
  ],
  providers: [
    ProverService,
    SlashingsService,
    WithdrawalsService,
    BadPerformersService,
    ConsolidationCacheManager,
    ConsolidationProofContextResolver,
    ConsolidationProofSender,
    ConsolidationsService,
  ],
  exports: [ProverService],
})
export class ProverModule {}
