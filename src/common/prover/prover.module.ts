import { Module } from '@nestjs/common';

import { SlashingsService } from './duties/slashings';
import { WithdrawalsService } from './duties/withdrawals';
import { ProverService } from './prover.service';
import { ContractsModule } from '../contracts/contracts.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule, ContractsModule],
  providers: [ProverService, SlashingsService, WithdrawalsService],
  exports: [ProverService],
})
export class ProverModule {}
