import { Module } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service';
import { CsmContract } from './csm-contract.service';
import { EjectorContract } from './ejector-contract.service';
import { ParametersRegistryContract } from './parameters-registry-contract.service';
import { StrikesContract } from './strikes-contract.service';
import { VerifierContract } from './verifier-contract.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  providers: [
    CsmContract,
    VerifierContract,
    StrikesContract,
    EjectorContract,
    AccountingContract,
    ParametersRegistryContract,
  ],
  exports: [
    CsmContract,
    VerifierContract,
    StrikesContract,
    EjectorContract,
    AccountingContract,
    ParametersRegistryContract,
  ],
})
export class ContractsModule {}
