import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { CsmContract } from './csm-contract.service';
import { Ejector, Ejector__factory } from './types';
import { ConfigService } from '../config/config.service';
import { KeyInfo } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class EjectorContract {
  private impl: Ejector;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly csm: CsmContract,
  ) {}

  // TODO: Move to onModuleInit after Mainnet release. Needed only for v1 -> v2 smooth transition
  public async init() {
    let address = this.config.get('EJECTOR_ADDRESS');
    if (!address || address == '') {
      this.logger.warn('EJECTOR_ADDRESS env variable is not specified. Trying to get role member from CSM contract...');
      const ejectorRoleMembers = await this.csm.getEjectorRoleMembers();
      if (ejectorRoleMembers.length == 0) {
        throw new Error('No one role member for were found');
      }
      if (ejectorRoleMembers.length > 1) {
        this.logger.warn('More than one role member were found. The first one will be used');
      }
      address = ejectorRoleMembers[0];
    }
    this.logger.log(`CSEjector address: ${address}`);
    this.impl = Ejector__factory.connect(address, this.execution.provider);
  }

  public async isEjectionProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.impl.isValidatorEjected(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async getBadPerformerEjectorRoleMembers(): Promise<string[]> {
    const members: string[] = [];
    const role = await this.impl.BAD_PERFORMER_EJECTOR_ROLE();
    const membersCount = (await this.impl.getRoleMemberCount(role)).toNumber();
    for (let i = 0; i < membersCount; i++) {
      const address = await this.impl.getRoleMember(role, i);
      members.push(address);
    }
    return members;
  }
}
