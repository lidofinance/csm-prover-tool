import { Injectable } from '@nestjs/common';

import { Csm, Csm__factory } from './types';
import { ConfigService } from '../config/config.service';
import { KeyInfo } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class CsmContract {
  private impl: Csm;

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    this.impl = Csm__factory.connect(this.config.get('CSM_ADDRESS'), this.execution.provider);
  }

  public async isWithdrawalProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.impl.isValidatorWithdrawn(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async getNodeOperatorKey(nodeOperatorId: string | number, keyIndex: string | number): Promise<string> {
    const [key] = await this.impl.getSigningKeys(nodeOperatorId, keyIndex, 1);
    return key;
  }
}
