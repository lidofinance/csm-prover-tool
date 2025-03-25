import { FetchError } from '@lido-nestjs/execution';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { Csm, Csm__factory } from './types';
import { ConfigService } from '../config/config.service';
import { KeyInfo } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class CsmContract {
  private impl: Csm;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const address = this.config.get('CSM_ADDRESS');
    this.logger.log(`CSModule address: ${address}`);
    this.impl = Csm__factory.connect(address, this.execution.provider);
  }

  public async getInitializedVersion(): Promise<number> {
    try {
      return (await this.impl.getInitializedVersion()).toNumber();
    } catch (e) {
      if (e.error instanceof FetchError) {
        return 1;
      }
      throw e;
    }
  }

  public async isWithdrawalProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.impl.isValidatorWithdrawn(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async getNodeOperatorKey(nodeOperatorId: string | number, keyIndex: string | number): Promise<string> {
    return await this.impl.getSigningKeys(nodeOperatorId, keyIndex, 1);
  }

  public async getAccountingAddress(): Promise<string> {
    return await this.impl.accounting();
  }

  public async getParamsAddress(): Promise<string> {
    return await this.impl.PARAMETERS_REGISTRY();
  }

  public async getVerifierRoleMembers(): Promise<string[]> {
    const members: string[] = [];
    const role = await this.impl.VERIFIER_ROLE();
    const membersCount = (await this.impl.getRoleMemberCount(role)).toNumber();
    for (let i = 0; i < membersCount; i++) {
      const address = await this.impl.getRoleMember(role, i);
      members.push(address);
    }
    return members;
  }

  public async getEjectorRoleMembers(): Promise<string[]> {
    const members: string[] = [];
    const role = await this.impl.EJECTOR_ROLE(); // FIXME: Should be actual role name
    const membersCount = (await this.impl.getRoleMemberCount(role)).toNumber();
    for (let i = 0; i < membersCount; i++) {
      const address = await this.impl.getRoleMember(role, i);
      members.push(address);
    }
    return members;
  }
}
