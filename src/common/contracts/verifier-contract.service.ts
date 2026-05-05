import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { CsmContract } from './csm-contract.service.js';
import { type Verifier, Verifier__factory } from './types/index.js';
import type { IVerifier } from './types/Verifier.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class VerifierContract {
  private contract: Verifier;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly csm: CsmContract,
  ) {}

  public async init() {
    let address = this.config.get('VERIFIER_ADDRESS');
    if (!address || address == '') {
      this.logger.warn(
        'VERIFIER_ADDRESS env variable is not specified. Trying to get role member from CSM contract...',
      );
      const verifierRoleMembers = await this.csm.getVerifierRoleMembers();
      if (verifierRoleMembers.length == 0) {
        throw new Error('No one member for VERIFIER_ROLE were found');
      }
      if (verifierRoleMembers.length > 1) {
        throw new Error(
          'You must specify `VERIFIER_ADDRESS` env. More than one `VERIFIER_ROLE` role member were found: ' +
            verifierRoleMembers,
        );
      }
      address = verifierRoleMembers[0];
    }
    this.logger.log(`CSVerifier address: ${address}`);
    this.contract = Verifier__factory.connect(address, this.execution.provider);

    let isPaused = false;
    try {
      isPaused = await this.isPaused();
    } catch (e) {
      if (e.code === 'CALL_EXCEPTION') {
        this.logger.warn(`CSVerifier ${address} does not support isPaused() method yet, assuming it is not paused`);
      } else {
        throw e;
      }
    }
    if (isPaused) {
      throw new Error(`CSVerifier ${address} is paused`);
    }
  }

  public async sendSlashingProof(payload: IVerifier.ProcessSlashedInputStruct): Promise<void> {
    await this.execution.execute(
      this.contract.callStatic.processSlashedProof,
      this.contract.populateTransaction.processSlashedProof,
      [payload],
    );
  }

  public async sendWithdrawalProof(payload: IVerifier.ProcessWithdrawalInputStruct): Promise<void> {
    await this.execution.execute(
      this.contract.callStatic.processWithdrawalProof,
      this.contract.populateTransaction.processWithdrawalProof,
      [payload],
    );
  }

  public async sendHistoricalWithdrawalProof(payload: IVerifier.ProcessHistoricalWithdrawalInputStruct): Promise<void> {
    await this.execution.execute(
      this.contract.callStatic.processHistoricalWithdrawalProof,
      this.contract.populateTransaction.processHistoricalWithdrawalProof,
      [payload],
    );
  }

  public async sendBalanceProof(payload: IVerifier.ProcessBalanceProofInputStruct): Promise<void> {
    await this.execution.execute(
      this.contract.callStatic.processBalanceProof,
      this.contract.populateTransaction.processBalanceProof,
      [payload],
    );
  }

  public async sendHistoricalBalanceProof(payload: IVerifier.ProcessHistoricalBalanceProofInputStruct): Promise<void> {
    await this.execution.execute(
      this.contract.callStatic.processHistoricalBalanceProof,
      this.contract.populateTransaction.processHistoricalBalanceProof,
      [payload],
    );
  }

  public async isPaused(): Promise<boolean> {
    return await this.contract.isPaused();
  }
}
