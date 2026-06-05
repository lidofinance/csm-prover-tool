import { type BlockTag } from '@ethersproject/abstract-provider';
import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';

import { StakingModuleContract } from './staking-module-contract.service.js';
import { type Accounting, Accounting__factory } from './types/index.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class AccountingContract {
  private contract: Accounting;
  private bondCurveIdCache = new LRUCache<string, number>({ max: 128 });

  constructor(
    protected readonly execution: Execution,
    protected readonly stakingModule: StakingModuleContract,
  ) {}

  public async init() {
    const accounting = await this.stakingModule.getAccountingAddress();
    this.contract = Accounting__factory.connect(accounting, this.execution.provider);
  }

  public async getCurvesCount(blockTag: BlockTag): Promise<number> {
    const count = await this.contract.getCurvesCount({ blockTag });
    return count.toNumber();
  }

  public async getBondCurveId(blockTag: BlockTag, nodeOperatorId: number): Promise<number> {
    const cacheKey = `${JSON.stringify(blockTag)}_${nodeOperatorId}`;
    let curveId = this.bondCurveIdCache.get(cacheKey);
    if (curveId === undefined) {
      curveId = (await this.contract.getBondCurveId(nodeOperatorId, { blockTag })).toNumber();
      this.bondCurveIdCache.set(cacheKey, curveId);
    }
    return curveId;
  }

  public async getFeeDistributorAddress(): Promise<string> {
    return await this.contract.FEE_DISTRIBUTOR();
  }
}
