import { Module } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service';
import { CsmContract } from './csm-contract.service';
import { ExitPenaltiesContract } from './exit-penalties-contract.service';
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
    ExitPenaltiesContract,
    AccountingContract,
    ParametersRegistryContract,
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
