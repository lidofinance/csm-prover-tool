import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { type Csm, Csm__factory } from './types/index.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class StakingModuleContract {
  private contract: Csm;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const address = this.config.get('STAKING_MODULE_ADDRESS');
    this.logger.log(`Staking module address: ${address}`);
    this.contract = Csm__factory.connect(address, this.execution.provider);
  }

  public async getInitializedVersion(): Promise<number> {
    try {
      return (await this.contract.getInitializedVersion()).toNumber();
    } catch (e) {
      if (e.code === 'CALL_EXCEPTION') {
        return 1;
      }
      throw e;
    }
  }

  public async canProveBalanceChanges(): Promise<boolean> {
    try {
      const topUpQueue = await this.contract.getTopUpQueue();
      return topUpQueue.enabled;
    } catch (e) {
      // TODO: replace this with an explicit module capability/version handler.
      if (e.code !== 'CALL_EXCEPTION' || e.data !== '0x') throw e;
      return true;
    }
  }

  public async getKeyAddedBalances(keyInfos: KeyInfo[]): Promise<bigint[]> {
    // Fetch each operator's candidate keys as one contiguous getKeyConfirmedBalances range
    const operatorIds = [...new Set(keyInfos.map((k) => k.operatorId))];
    const rangeByOperator: Record<number, { start: number; balances: bigint[] }> = {};
    await Promise.all(
      operatorIds.map(async (operatorId) => {
        const keyIndexes = keyInfos.filter((k) => k.operatorId === operatorId).map((k) => k.keyIndex);
        const start = Math.min(...keyIndexes);
        const count = Math.max(...keyIndexes) - start + 1;
        const balances = await this.contract.getKeyConfirmedBalances(operatorId, start, count);
        rangeByOperator[operatorId] = { start, balances: balances.map((b) => b.toBigInt()) };
      }),
    );

    return keyInfos.map(({ operatorId, keyIndex }) => {
      const { start, balances } = rangeByOperator[operatorId];
      return balances[keyIndex - start];
    });
  }

  public async isWithdrawalProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.contract.isValidatorWithdrawn(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async isSlashingProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.contract.isValidatorSlashed(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async getNodeOperatorKey(nodeOperatorId: string | number, keyIndex: string | number): Promise<string> {
    return await this.contract.getSigningKeys(nodeOperatorId, keyIndex, 1);
  }

  public async getAccountingAddress(): Promise<string> {
    return await this.contract.ACCOUNTING();
  }

  public async getParamsAddress(): Promise<string> {
    return await this.contract.PARAMETERS_REGISTRY();
  }

  public async getVerifierRoleMembers(): Promise<string[]> {
    const members: string[] = [];
    const role = await this.contract.VERIFIER_ROLE();
    const membersCount = (await this.contract.getRoleMemberCount(role)).toNumber();
    for (let i = 0; i < membersCount; i++) {
      const address = await this.contract.getRoleMember(role, i);
      members.push(address);
    }
    return members;
  }
}
