import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { type GetContractReturnType, type PublicClient, getContract } from 'viem';

import { parametersRegistryAbi } from './abi/parameters-registry.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class ParametersRegistryContract {
  private contract: GetContractReturnType<typeof parametersRegistryAbi, PublicClient>;
  private strikesThresholdCache = new LRUCache<string, bigint>({ max: 128 });

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

  public async getStrikesThreshold(blockNumber: bigint, curveId: bigint): Promise<bigint> {
    const cacheKey = `${blockNumber}_${curveId}`;
    let threshold = this.strikesThresholdCache.get(cacheKey);
    if (threshold === undefined) {
      [, threshold] = await this.contract.read.getStrikesParams([curveId], { blockNumber });
      this.strikesThresholdCache.set(cacheKey, threshold);
    }
    return threshold;
  }
}
