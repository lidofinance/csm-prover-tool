import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { BadPerformersService } from './duties/bad-performers.service.js';
import { BalancesService } from './duties/balances.service.js';
import { ProverService } from './prover.service.js';
import { ContractsModule } from '../contracts/contracts.module.js';
import { CsmContract } from '../contracts/csm-contract.service.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { SlashingsService } from './duties/slashings.service.js';
import { WithdrawalsService } from './duties/withdrawals.service.js';

const BalancesProvider = {
  provide: BalancesService,
  useFactory: async (csm: CsmContract, moduleRef: ModuleRef): Promise<BalancesService | undefined> =>
    (await csm.canProveBalanceChanges()) ? moduleRef.create(BalancesService) : undefined,
  inject: [CsmContract, ModuleRef],
};

@Module({
  imports: [ProvidersModule, ContractsModule, WorkersModule],
  providers: [ProverService, SlashingsService, WithdrawalsService, BadPerformersService, BalancesProvider],
  exports: [ProverService],
})
export class ProverModule {}
