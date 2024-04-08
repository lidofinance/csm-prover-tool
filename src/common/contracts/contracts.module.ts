import { Module } from '@nestjs/common';

import { CsmContract } from './csm-contract.service';
import { VerifierContract } from './verifier-contract.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  providers: [CsmContract, VerifierContract],
  exports: [CsmContract, VerifierContract],
})
export class ContractsModule {}
