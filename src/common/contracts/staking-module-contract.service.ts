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

  public async getKeyAddedBalances(keyInfos: KeyInfo[], blockNumber: number): Promise<bigint[]> {
    const balances = await Promise.all(
      keyInfos.map(({ operatorId, keyIndex }) =>
        this.contract.getKeyConfirmedBalances(operatorId, keyIndex, 1, { blockTag: blockNumber }),
      ),
    );
    return balances.map(([balance]) => balance.toBigInt());
  }

  public async isWithdrawalProved(keyInfo: KeyInfo, blockNumber: number): Promise<boolean> {
    return await this.contract.isValidatorWithdrawn(keyInfo.operatorId, keyInfo.keyIndex, { blockTag: blockNumber });
  }

  public async isSlashingProved(keyInfo: KeyInfo, blockNumber: number): Promise<boolean> {
    return await this.contract.isValidatorSlashed(keyInfo.operatorId, keyInfo.keyIndex, { blockTag: blockNumber });
  }

  public async getNodeOperatorsCount(blockNumber: number): Promise<number> {
    return (await this.contract.getNodeOperatorsCount({ blockTag: blockNumber })).toNumber();
  }

  public async getDepositedKeysCounts(operatorIds: number[], blockNumber: number): Promise<number[]> {
    const operators = await Promise.all(
      operatorIds.map((operatorId) => this.contract.getNodeOperator(operatorId, { blockTag: blockNumber })),
    );
    return operators.map(({ totalDepositedKeys }) => totalDepositedKeys);
  }

  public async getNodeOperatorKey(nodeOperatorId: number, keyIndex: number, blockNumber: number): Promise<string> {
    return await this.contract.getSigningKeys(nodeOperatorId, keyIndex, 1, { blockTag: blockNumber });
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
