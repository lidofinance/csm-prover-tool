import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service';
import { CsmContract } from './csm-contract.service';
import { ExitPenaltiesContract } from './exit-penalties-contract.service';
import { ParametersRegistryContract } from './parameters-registry-contract.service';
import { StrikesContract } from './strikes-contract.service';
import { VerifierContract } from './verifier-contract.service';

@Injectable()
export class ContractsInitializer implements OnModuleInit {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly csm: CsmContract,
    protected readonly accounting: AccountingContract,
    protected readonly params: ParametersRegistryContract,
    protected readonly strikes: StrikesContract,
    protected readonly exitPenalties: ExitPenaltiesContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async onModuleInit(): Promise<void> {
    this.logger.log('Initializing contract services...');

    // Ensure CSM is reachable and log its init version for visibility
    try {
      const version = await this.csm.getInitializedVersion();
      this.logger.log(`CSM initialized version: v${version}`);
    } catch (e) {
      this.logger.warn(`Failed to read CSM initialized version: ${e?.message ?? e}`);
    }

    // Initialize dependent contracts in order
    await this.accounting.init();
    await this.params.init();
    await this.strikes.init();
    await this.exitPenalties.init();
    await this.verifier.init();

    this.logger.log('Contract services initialized');
  }
}
