import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { ConsolidationCacheStoreModule } from './cache/consolidation-cache-store.module.js';
import { BadPerformersService } from './duties/bad-performers.service.js';
import { BalancesService } from './duties/balances.service.js';
import { ProverService } from './prover.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { ConsolidationCacheManager } from './duties/consolidations/consolidation-cache-manager.js';
import { ConsolidationProofContextResolver } from './duties/consolidations/consolidation-proof-context.js';
import { ConsolidationProofSender } from './duties/consolidations/consolidation-proof-sender.js';
import { ConsolidationsService } from './duties/consolidations.service.js';
import { SlashingsService } from './duties/slashings.service.js';
import { WithdrawalsService } from './duties/withdrawals.service.js';

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
    BalancesService,
  ],
  exports: [ProverService],
})
export class ProverModule {}
