import { Injectable, OnModuleInit } from '@nestjs/common';
import { LRUCache } from 'lru-cache';

import { CsmContract } from './csm-contract.service';
import { Accounting, Accounting__factory } from './types';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class AccountingContract implements OnModuleInit {
  private impl: Accounting;
  private bondCurveIdCache = new LRUCache<string, number>({ max: 128 });

  constructor(
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly csm: CsmContract,
  ) {}

  async onModuleInit() {
    const accounting = await this.csm.getAccountingAddress();
    this.impl = Accounting__factory.connect(accounting, this.execution.provider);
  }

  public async getBondCurveId(blockHash: string, nodeOperatorId: number): Promise<number> {
    let curveId = this.bondCurveIdCache.get(`${blockHash}_${nodeOperatorId}`);
    if (!curveId) {
      curveId = (await this.impl.getBondCurveId(nodeOperatorId)).toNumber();
      this.bondCurveIdCache.set(`${blockHash}_${nodeOperatorId}`, curveId);
    }
    return curveId;
  }

  public async getFeeDistributorAddress(): Promise<string> {
    return await this.impl.feeDistributor();
  }
}
