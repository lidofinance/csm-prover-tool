import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { ConsolidationCacheManager } from './consolidations/consolidation-cache-manager.js';
import { ConsolidationProofSender } from './consolidations/consolidation-proof-sender.js';
import type { ConsolidationToProve } from './consolidations/consolidations.types.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus } from '../../providers/consensus/consensus.js';
import type { SupportedBlock } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfoFn } from '../types.js';

@Injectable()
export class ConsolidationsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly cacheManager: ConsolidationCacheManager,
    protected readonly proofSender: ConsolidationProofSender,
  ) {}

  public async sendConsolidationProofs(
    finalizedHeader: BlockHeaderResponse,
    consolidations: ConsolidationToProve[],
  ): Promise<number> {
    const sentCount = await this.proofSender.send(finalizedHeader, consolidations);
    await this.cacheManager.flush();
    return sentCount;
  }

  public async getConsolidationsToProve(
    blockInfo: SupportedBlock,
    keyInfoFn: KeyInfoFn,
  ): Promise<ConsolidationToProve[]> {
    const currentEpoch = this.consensus.slotToEpoch(Number(blockInfo.slot));
    const stateRoot = toRootHex(blockInfo.stateRoot);
    const state = await this.consensus.getState(stateRoot);
    const statePending = await this.workers.inspectPendingConsolidations({ state });
    const statePendingKeys = this.cacheManager.syncFromState(statePending, keyInfoFn);

    // Called on the first processed slot in an epoch, so parentRoot points to the state
    // before epoch transition consolidations are applied.
    const consolidationBlockRoot = toRootHex(blockInfo.parentRoot);
    const toProve = this.cacheManager.collectToProve(statePendingKeys, currentEpoch, consolidationBlockRoot, keyInfoFn);
    const unproven = toProve.length ? await this.cacheManager.filterUnproven(toProve) : [];
    await this.cacheManager.flush();
    if (!unproven.length) return [];
    this.logger.warn(`🔍 Unproven consolidations: ${unproven.length}`);
    return unproven;
  }
}
