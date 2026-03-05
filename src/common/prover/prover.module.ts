import { Module } from '@nestjs/common';

import { BadPerformersService } from './duties/bad-performers.service.js';
import { BalancesService } from './duties/balances.service.js';
import { ProverService } from './prover.service.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { SlashingsService } from './duties/slashings.service.js';
import { WithdrawalsService } from './duties/withdrawals.service.js';

@Module({
  imports: [ProvidersModule, ContractsModule, WorkersModule],
  providers: [ProverService, SlashingsService, WithdrawalsService, BadPerformersService, BalancesService],
  exports: [ProverService],
})
export class ProverModule {}
