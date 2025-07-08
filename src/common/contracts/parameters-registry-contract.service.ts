import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { LRUCache } from 'lru-cache';

import { CsmContract } from './csm-contract.service';
import { ParametersRegistry, ParametersRegistry__factory } from './types';
import { ConfigService } from '../config/config.service';
import { Execution } from '../providers/execution/execution';
import { BlockTag } from '@ethersproject/abstract-provider';

@Injectable()
export class ParametersRegistryContract {
  private contract: ParametersRegistry;
  private strikeParamsCache = new LRUCache<string, { lifetime: number; threshold: number }>({ max: 128 });

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly csm: CsmContract,
  ) {}

  // TODO: Move to onModuleInit after Mainnet release. Needed only for v1 -> v2 smooth transition
  public async init() {
    const address = await this.csm.getParamsAddress();
    this.logger.log(`CSParametersRegistry address: ${address}`);
    this.contract = ParametersRegistry__factory.connect(address, this.execution.provider);
  }

  public async getStrikeParams(blockTag: BlockTag, curveId: number): Promise<{ lifetime: number; threshold: number }> {
    let params = this.strikeParamsCache.get(`${blockTag}_${curveId}`);
    if (!params) {
      const result = await this.contract.getStrikesParams(curveId, { blockTag });
      params = { lifetime: result.lifetime.toNumber(), threshold: result.threshold.toNumber() };
      this.strikeParamsCache.set(`${blockTag}_${curveId}`, params);
    }
    return params;
  }
}
