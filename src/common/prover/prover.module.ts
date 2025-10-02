import { Module } from '@nestjs/common';

import { WithdrawalsService } from './duties/withdrawals.service';
import { ProverService } from './prover.service';
import { ContractsModule } from '../contracts';
import { ProvidersModule } from '../providers/providers.module';
import { WorkersModule } from '../workers/workers.module';
import { BadPerformersService } from './duties/bad-performers.service';

@Module({
  imports: [ProvidersModule, ContractsModule, WorkersModule],
  providers: [ProverService, WithdrawalsService, BadPerformersService],
  exports: [ProverService],
})
export class ProverModule {}
