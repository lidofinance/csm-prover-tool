import { Inject, Injectable } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { type Address, type GetContractReturnType, type Hex, type PublicClient, getContract } from 'viem';

import { csmAbi } from './abi/csm.js';
import { findContractRevert } from './contract-revert.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class StakingModuleContract {
  private contract: GetContractReturnType<typeof csmAbi, PublicClient>;

  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const address = this.config.get('STAKING_MODULE_ADDRESS');
    this.logger.log(`Staking module address: ${address}`);
    this.contract = getContract({ address, abi: csmAbi, client: this.execution.client });
  }

  public async getInitializedVersion(): Promise<bigint> {
    try {
      return await this.contract.read.getInitializedVersion();
    } catch (e) {
      if (findContractRevert(e)) {
        return 1n;
      }
      throw e;
    }
  }

  public async canProveBalanceChanges(): Promise<boolean> {
    try {
      const [enabled] = await this.contract.read.getTopUpQueue();
      return enabled;
    } catch (e) {
      // TODO: replace this with an explicit module capability/version handler.
      if (findContractRevert(e)?.raw !== '0x') throw e;
      return true;
    }
  }

  public async getKeyAddedBalances(keyInfos: KeyInfo[], blockNumber: bigint): Promise<bigint[]> {
    const balances = await Promise.all(
      keyInfos.map(({ operatorId, keyIndex }) =>
        this.contract.read.getKeyConfirmedBalances([BigInt(operatorId), BigInt(keyIndex), 1n], {
          blockNumber,
        }),
      ),
    );
    return balances.map(([balance]) => balance);
  }

  public async isWithdrawalProved(keyInfo: KeyInfo, blockNumber: bigint): Promise<boolean> {
    return await this.contract.read.isValidatorWithdrawn([BigInt(keyInfo.operatorId), BigInt(keyInfo.keyIndex)], {
      blockNumber,
    });
  }

  public async isSlashingProved(keyInfo: KeyInfo, blockNumber: bigint): Promise<boolean> {
    return await this.contract.read.isValidatorSlashed([BigInt(keyInfo.operatorId), BigInt(keyInfo.keyIndex)], {
      blockNumber,
    });
  }

  public async getNodeOperatorsCount(blockNumber: bigint): Promise<bigint> {
    return await this.contract.read.getNodeOperatorsCount({ blockNumber });
  }

  public async getDepositedKeysCounts(operatorIds: number[], blockNumber: bigint): Promise<number[]> {
    const operators = await Promise.all(
      operatorIds.map((operatorId) => this.contract.read.getNodeOperator([BigInt(operatorId)], { blockNumber })),
    );
    return operators.map(({ totalDepositedKeys }) => totalDepositedKeys);
  }

  public async getNodeOperatorKey(nodeOperatorId: number, keyIndex: number, blockNumber: bigint): Promise<Hex> {
    return await this.contract.read.getSigningKeys([BigInt(nodeOperatorId), BigInt(keyIndex), 1n], {
      blockNumber,
    });
  }

  public async getAccountingAddress(): Promise<Address> {
    return await this.contract.read.ACCOUNTING();
  }

  public async getParamsAddress(): Promise<Address> {
    return await this.contract.read.PARAMETERS_REGISTRY();
  }

  public async getVerifierRoleMembers(): Promise<Address[]> {
    const members: Address[] = [];
    const role = await this.contract.read.VERIFIER_ROLE();
    const membersCount = await this.contract.read.getRoleMemberCount([role]);
    for (let i = 0n; i < membersCount; i++) {
      const address = await this.contract.read.getRoleMember([role, i]);
      members.push(address);
    }
    return members;
  }
}
