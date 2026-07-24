import { Module } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service.js';
import { ContractsInitializer } from './contracts-initializer.service.js';
import { ExitPenaltiesContract } from './exit-penalties-contract.service.js';
import { ParametersRegistryContract } from './parameters-registry-contract.service.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import { StrikesContract } from './strikes-contract.service.js';
import { VerifierContract } from './verifier-contract.service.js';
import { ProvidersModule } from '../providers/providers.module.js';

@Module({
  imports: [ProvidersModule],
  providers: [
    StakingModuleContract,
    VerifierContract,
    StrikesContract,
    ExitPenaltiesContract,
    AccountingContract,
    ParametersRegistryContract,
    ContractsInitializer,
  ],
  exports: [
    StakingModuleContract,
    VerifierContract,
    StrikesContract,
    ExitPenaltiesContract,
    AccountingContract,
    ParametersRegistryContract,
  ],
})
export class ContractsModule {}
