import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { AccountingContract } from './accounting-contract.service.js';
import { ExitPenaltiesContract } from './exit-penalties-contract.service.js';
import { ParametersRegistryContract } from './parameters-registry-contract.service.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import { StrikesContract } from './strikes-contract.service.js';
import { VerifierContract } from './verifier-contract.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';

@Injectable()
export class ContractsInitializer implements OnModuleInit {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly accounting: AccountingContract,
    protected readonly params: ParametersRegistryContract,
    protected readonly strikes: StrikesContract,
    protected readonly exitPenalties: ExitPenaltiesContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async onModuleInit(): Promise<void> {
    this.logger.log('Initializing contract services...');

    // Ensure staking module is reachable and log its init version for visibility
    try {
      const version = await this.stakingModule.getInitializedVersion();
      this.logger.log(`Staking module initialized version: v${version}`);
    } catch (e) {
      this.logger.warn(`Failed to read staking module initialized version: ${e?.message ?? e}`);
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
