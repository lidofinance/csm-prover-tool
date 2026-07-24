import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer.js';
import { type RootSlot, RootsStack } from './roots-stack.js';
import { toRootHex } from '../../common/helpers/proofs.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import { PrometheusService } from '../../common/prometheus/index.js';
import { ProverService } from '../../common/prover/prover.service.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import type { SupportedBlock } from '../../common/providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../common/providers/consensus/response.interface.js';

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsStack: RootsStack,
    protected readonly prover: ProverService,
  ) {}

  public async processNext(blockRootToProcess: RootHex, finalizedHeader: BlockHeaderResponse): Promise<void> {
    this.logger.log(`🛃 Root in processing [${blockRootToProcess}]`);
    const blockInfoToProcess = await this.consensus.getBlockInfo(blockRootToProcess);
    const rootSlot: RootSlot = {
      blockRoot: blockRootToProcess,
      slotNumber: blockInfoToProcess.slot,
    };
    await this.rootsStack.push(rootSlot); // in case of revert we should reprocess the root
    {
      await this.prover.handleSlashingsInBlock(blockInfoToProcess, finalizedHeader, this.keysIndexer.getKey);
      await this.prover.handleWithdrawalsInBlock(
        blockRootToProcess,
        blockInfoToProcess,
        finalizedHeader,
        this.keysIndexer.getKey,
      );
      if (await this.isFirstBlockInEpoch(blockInfoToProcess)) {
        await this.prover.handleBalanceChangesInBlock(blockRootToProcess, finalizedHeader, this.keysIndexer.getAllKeys);
      }
    }
    const indexerIsTrusted = this.keysIndexer.isTrustedForEveryDuty(rootSlot.slotNumber);
    if (indexerIsTrusted) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }

  private async isFirstBlockInEpoch(blockInfo: SupportedBlock): Promise<boolean> {
    const currentSlot = Number(blockInfo.slot);
    // The parent is the last processed root in the sequential walk, so reuse its slot instead of fetching its
    // header; fetch only when it isn't (cold start, stack replay, revert).
    const parentRoot = toRootHex(blockInfo.parentRoot);
    const lastProcessed = this.rootsStack.getLastProcessed();
    let parentSlot: number;
    if (lastProcessed && parentRoot === lastProcessed.blockRoot) {
      parentSlot = lastProcessed.slotNumber;
    } else {
      parentSlot = Number((await this.consensus.getBeaconHeader(parentRoot)).header.message.slot);
    }
    return this.consensus.slotToEpoch(parentSlot) < this.consensus.slotToEpoch(currentSlot);
  }
}
