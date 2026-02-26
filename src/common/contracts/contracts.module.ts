import { Module } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service.js';
import { ContractsInitializer } from './contracts-initializer.service.js';
import { CsmContract } from './csm-contract.service.js';
import { ExitPenaltiesContract } from './exit-penalties-contract.service.js';
import { ParametersRegistryContract } from './parameters-registry-contract.service.js';
import { StrikesContract } from './strikes-contract.service.js';
import { VerifierContract } from './verifier-contract.service.js';
import { ProvidersModule } from '../providers/providers.module.js';

@Module({
  imports: [ProvidersModule],
  providers: [
    CsmContract,
    VerifierContract,
    StrikesContract,
    ExitPenaltiesContract,
    AccountingContract,
    ParametersRegistryContract,
    ContractsInitializer,
  ],
  exports: [
    CsmContract,
    VerifierContract,
    StrikesContract,
    ExitPenaltiesContract,
    AccountingContract,
    ParametersRegistryContract,
  ],
})
export class ContractsModule {}
