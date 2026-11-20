import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
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
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const address = this.config.get('STAKING_MODULE_ADDRESS');
    this.logger.log(`Staking module address: ${address}`);
    this.contract = getContract({ address, abi: csmAbi, client: this.execution.client });
  }

  public async getInitializedVersion(): Promise<number> {
    try {
      return Number(await this.contract.read.getInitializedVersion());
    } catch (e) {
      if (findContractRevert(e)) {
        return 1;
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

  public async getKeyAddedBalances(keyInfos: KeyInfo[], blockNumber: number): Promise<bigint[]> {
    const balances = await Promise.all(
      keyInfos.map(({ operatorId, keyIndex }) =>
        this.contract.read.getKeyConfirmedBalances([BigInt(operatorId), BigInt(keyIndex), 1n], {
          blockNumber: BigInt(blockNumber),
        }),
      ),
    );
    return balances.map(([balance]) => balance);
  }

  public async isWithdrawalProved(keyInfo: KeyInfo, blockNumber: number): Promise<boolean> {
    return await this.contract.read.isValidatorWithdrawn([BigInt(keyInfo.operatorId), BigInt(keyInfo.keyIndex)], {
      blockNumber: BigInt(blockNumber),
    });
  }

  public async isSlashingProved(keyInfo: KeyInfo, blockNumber: number): Promise<boolean> {
    return await this.contract.read.isValidatorSlashed([BigInt(keyInfo.operatorId), BigInt(keyInfo.keyIndex)], {
      blockNumber: BigInt(blockNumber),
    });
  }

  public async getNodeOperatorsCount(blockNumber: number): Promise<number> {
    return Number(await this.contract.read.getNodeOperatorsCount({ blockNumber: BigInt(blockNumber) }));
  }

  public async getDepositedKeysCounts(operatorIds: number[], blockNumber: number): Promise<number[]> {
    const operators = await Promise.all(
      operatorIds.map((operatorId) =>
        this.contract.read.getNodeOperator([BigInt(operatorId)], { blockNumber: BigInt(blockNumber) }),
      ),
    );
    return operators.map(({ totalDepositedKeys }) => totalDepositedKeys);
  }

  public async getNodeOperatorKey(nodeOperatorId: number, keyIndex: number, blockNumber: number): Promise<Hex> {
    return await this.contract.read.getSigningKeys([BigInt(nodeOperatorId), BigInt(keyIndex), 1n], {
      blockNumber: BigInt(blockNumber),
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
    const membersCount = Number(await this.contract.read.getRoleMemberCount([role]));
    for (let i = 0; i < membersCount; i++) {
      const address = await this.contract.read.getRoleMember([role, BigInt(i)]);
      members.push(address);
    }
    return members;
  }
}
