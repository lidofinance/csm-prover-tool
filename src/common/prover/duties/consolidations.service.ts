import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { toRootHex } from '../../helpers/proofs';
import { Consensus, SupportedBlock } from '../../providers/consensus/consensus';
import { BlockHeaderResponse } from '../../providers/consensus/response.interface';
import { WorkersService } from '../../workers/workers.service';
import { KeyInfoFn } from '../types';
import { ConsolidationCacheManager } from './consolidations/consolidation-cache-manager';
import { ConsolidationProofSender } from './consolidations/consolidation-proof-sender';
import { ConsolidationToProve } from './consolidations/consolidations.types';

@Injectable()
export class ConsolidationsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
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
