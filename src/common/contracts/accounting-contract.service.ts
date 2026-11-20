import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { type Address, type GetContractReturnType, type PublicClient, getContract } from 'viem';

import { accountingAbi } from './abi/accounting.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class AccountingContract {
  private contract: GetContractReturnType<typeof accountingAbi, PublicClient>;
  private bondCurveIdCache = new LRUCache<string, bigint>({ max: 128 });

  constructor(
    protected readonly execution: Execution,
    protected readonly stakingModule: StakingModuleContract,
  ) {}

  public async init() {
    const accounting = await this.stakingModule.getAccountingAddress();
    this.contract = getContract({ address: accounting, abi: accountingAbi, client: this.execution.client });
  }

  public async getCurvesCount(blockNumber: bigint): Promise<number> {
    const count = await this.contract.read.getCurvesCount({ blockNumber });
    return Number(count);
  }

  public async getBondCurveId(blockNumber: bigint, nodeOperatorId: number): Promise<bigint> {
    const cacheKey = `${blockNumber}_${nodeOperatorId}`;
    let curveId = this.bondCurveIdCache.get(cacheKey);
    if (curveId === undefined) {
      curveId = await this.contract.read.getBondCurveId([BigInt(nodeOperatorId)], { blockNumber });
      this.bondCurveIdCache.set(cacheKey, curveId);
    }
    return curveId;
  }

  public async getFeeDistributorAddress(): Promise<Address> {
    return await this.contract.read.FEE_DISTRIBUTOR();
  }
}
