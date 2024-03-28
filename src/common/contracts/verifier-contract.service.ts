import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { Verifier, Verifier__factory } from './types';
import { ConfigService } from '../config/config.service';
import { HistoricalWithdrawalsProofPayload, SlashingProofPayload, WithdrawalsProofPayload } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class VerifierContract {
  private impl: Verifier;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    this.impl = Verifier__factory.connect(this.config.get('VERIFIER_ADDRESS'), this.execution.provider);
  }

  public async sendSlashingProof(payload: SlashingProofPayload): Promise<void> {
    this.logger.debug!(payload);
    await this.execution.execute(
      this.impl.callStatic.processSlashingProof,
      this.impl.populateTransaction.processSlashingProof,
      [payload.beaconBlock, payload.witness, payload.nodeOperatorId, payload.keyIndex],
    );
  }

  public async sendWithdrawalProof(payload: WithdrawalsProofPayload): Promise<void> {
    this.logger.debug!(payload);
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
}
