import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import { CsmContract } from './csm-contract.service';
import { Verifier, Verifier__factory } from './types';
import { ConfigService } from '../config/config.service';
import { HistoricalWithdrawalsProofPayload, WithdrawalsProofPayload } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class VerifierContract implements OnModuleInit {
  private impl: Verifier;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly csm: CsmContract,
  ) {}

  async onModuleInit() {
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
        this.logger.warn('More than one VERIFIER_ROLE role member were found. The first one will be used');
      }
      address = verifierRoleMembers[0];
    }
    this.logger.log(`CSVerifier address: ${address}`);
    this.impl = Verifier__factory.connect(address, this.execution.provider);
    const isPaused = await this.impl.isPaused();
    if (isPaused) {
      throw new Error(`CSVerifier ${address} is paused`);
    }
  }

  public async sendWithdrawalProof(payload: WithdrawalsProofPayload): Promise<void> {
    await this.execution.execute(
      this.impl.callStatic.processWithdrawalProof,
      this.impl.populateTransaction.processWithdrawalProof,
      [payload.beaconBlock, payload.witness, payload.nodeOperatorId, payload.keyIndex],
    );
  }

  public async sendHistoricalWithdrawalProof(payload: HistoricalWithdrawalsProofPayload): Promise<void> {
    await this.execution.execute(
      this.impl.callStatic.processHistoricalWithdrawalProof,
      this.impl.populateTransaction.processHistoricalWithdrawalProof,
      [payload.beaconBlock, payload.oldBlock, payload.witness, payload.nodeOperatorId, payload.keyIndex],
    );
  }

  public async isPaused(): Promise<boolean> {
    return await this.impl.isPaused();
  }
}
