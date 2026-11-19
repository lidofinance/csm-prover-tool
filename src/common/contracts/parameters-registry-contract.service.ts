import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { type GetContractReturnType, type PublicClient, getContract } from 'viem';

import { parametersRegistryAbi } from './abi/parameters-registry.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { Execution } from '../providers/execution/execution.js';

type ParametersRegistry = GetContractReturnType<typeof parametersRegistryAbi, PublicClient>;

@Injectable()
export class ParametersRegistryContract {
  private contract: ParametersRegistry;
  private strikeParamsCache = new LRUCache<string, { lifetime: number; threshold: number }>({ max: 128 });

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly execution: Execution,
    protected readonly stakingModule: StakingModuleContract,
  ) {}

  public async init() {
    const address = await this.stakingModule.getParamsAddress();
    this.logger.log(`CSParametersRegistry address: ${address}`);
    this.contract = getContract({ address, abi: parametersRegistryAbi, client: this.execution.client });
  }

  public async getStrikeParams(blockNumber: number, curveId: number): Promise<{ lifetime: number; threshold: number }> {
    const cacheKey = `${blockNumber}_${curveId}`;
    let params = this.strikeParamsCache.get(cacheKey);
    if (!params) {
      const [lifetime, threshold] = await this.contract.read.getStrikesParams([BigInt(curveId)], {
        blockNumber: BigInt(blockNumber),
      });
      params = { lifetime: Number(lifetime), threshold: Number(threshold) };
      this.strikeParamsCache.set(cacheKey, params);
    }
    return params;
  }
}
