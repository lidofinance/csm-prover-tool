import { Module } from '@nestjs/common';

import { SlashingsService } from './duties/slashings.service';
import { WithdrawalsService } from './duties/withdrawals.service';
import { ProverService } from './prover.service';
import { ContractsModule } from '../contracts/contracts.module';
import { ProvidersModule } from '../providers/providers.module';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [ProvidersModule, ContractsModule, WorkersModule],
  providers: [ProverService, SlashingsService, WithdrawalsService],
  exports: [ProverService],
})
export class ProverModule {}
