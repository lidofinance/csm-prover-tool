import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';

import { CsmContract } from '../../contracts/csm-contract.service';
import { VerifierContract } from '../../contracts/verifier-contract.service';
import { toRootHex } from '../../helpers/proofs';
import { Consensus, State, SupportedBlock } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../providers/consensus/response.interface';
import type { PendingConsolidationInfo } from '../../workers/items/inspect-pending-consolidations';
import { WorkersService } from '../../workers/workers.service';
import {
  ConsolidationCacheStore,
  ConsolidationKey,
  NoopConsolidationCacheStore,
  PersistentConsolidationCacheStore,
} from '../cache/consolidation-cache-store';
import { KeyInfo, KeyInfoFn } from '../types';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../utils/historical-summary';

type ConsolidationProofContext = {
  consolidationHeader: BlockHeaderResponse;
  consolidationState: State;
  summaryState: State;
  summaryIndex: number;
  rootIndexInSummary: number;
};

export type ConsolidationToProve = {
  sourceIndex: number;
  targetIndex: number;
  consolidationBlockRoot: RootHex;
  keyInfo: KeyInfo;
};

@Injectable()
export class ConsolidationsService implements OnModuleInit {
  private readonly cacheStore: ConsolidationCacheStore;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly csm: CsmContract,
    protected readonly verifier: VerifierContract,
    @Optional() cacheStore?: PersistentConsolidationCacheStore,
  ) {
    this.cacheStore = cacheStore ?? new NoopConsolidationCacheStore();
  }

  public async onModuleInit(): Promise<void> {
    await this.cacheStore.ensureReady();
  }

  public async sendConsolidationProofs(
    finalizedHeader: BlockHeaderResponse,
    consolidations: ConsolidationToProve[],
  ): Promise<number> {
    if (!consolidations.length) return 0;
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    if (!nextHeader) throw new Error(`Next block header after ${finalizedHeader.root} not found`);
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));

    const grouped = this.groupConsolidationsByRoot(consolidations);

    let sentCount = 0;
    for (const [consolidationBlockRoot, items] of grouped.entries()) {
      const context = await this.getConsolidationProofContext(consolidationBlockRoot, finalizedHeader);
      if (!context) continue;
      this.logger.log('Building consolidation proof payloads');
      const payloads = await this.workers.getConsolidationProofPayloads({
        recentHeader: finalizedHeader,
        nextHeaderTimestamp: nextHeaderTs,
        recentState: finalizedState,
        consolidationHeader: context.consolidationHeader,
        consolidationState: context.consolidationState,
        summaryState: context.summaryState,
        summaryIndex: context.summaryIndex,
        rootIndexInSummary: context.rootIndexInSummary,
        consolidations: items,
      });
      for (const payload of payloads) {
        this.logger.log(`📡 Sending consolidation proof payload for validator index: ${payload.validator.index}`);
        await this.verifier.sendConsolidationProof(payload);
        sentCount++;
      }
    }
    await this.cacheStore.flushIfPendingWrite();
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
    const statePendingKeys = this.syncCacheFromState(statePending, keyInfoFn);

    // Called on the first processed slot in an epoch, so parentRoot points to the state
    // before epoch transition consolidations are applied.
    const consolidationBlockRoot = toRootHex(blockInfo.parentRoot);
    const toProve = this.collectConsolidationsToProve(
      statePendingKeys,
      currentEpoch,
      consolidationBlockRoot,
      keyInfoFn,
    );
    const unproven = toProve.length ? await this.filterUnprovenConsolidations(toProve) : [];
    await this.cacheStore.flushIfPendingWrite();
    if (!unproven.length) return [];
    this.logger.warn(`🔍 Unproven consolidations: ${unproven.length}`);
    return unproven;
  }

  private syncCacheFromState(statePending: PendingConsolidationInfo[], keyInfoFn: KeyInfoFn): Set<ConsolidationKey> {
    const statePendingKeys = new Set<ConsolidationKey>();
    // Sync pendingConsolidations from state into the cache (Lido-only by source index).
    for (const statePendingItem of statePending) {
      if (!keyInfoFn(statePendingItem.sourceIndex)) {
        // Skip consolidations for non-Lido validators.
        continue;
      }
      const key = this.cacheStore.makeKey(statePendingItem.sourceIndex, statePendingItem.targetIndex);
      // Save the key to identify which pending consolidations are still in state.
      statePendingKeys.add(key);
      // Sync cache entries.
      if (statePendingItem.slashed) {
        this.logger.log(`Removing consolidation ${key} from cache because source validator is slashed`);
        this.cacheStore.delete(key);
        continue;
      }
      const cached = this.cacheStore.get(key);
      if (cached) {
        if (cached.withdrawableEpoch !== statePendingItem.withdrawableEpoch) {
          throw new Error(
            `Withdrawable epoch mismatch for consolidation ${key}: cached=${cached.withdrawableEpoch}, state=${statePendingItem.withdrawableEpoch}`,
          );
        }
        continue;
      }
      this.cacheStore.set(key, {
        sourceIndex: statePendingItem.sourceIndex,
        targetIndex: statePendingItem.targetIndex,
        withdrawableEpoch: statePendingItem.withdrawableEpoch,
      });
    }
    return statePendingKeys;
  }

  private collectConsolidationsToProve(
    statePendingKeys: Set<ConsolidationKey>,
    currentEpoch: number,
    consolidationBlockRoot: RootHex,
    keyInfoFn: KeyInfoFn,
  ): ConsolidationToProve[] {
    const toProve: ConsolidationToProve[] = [];
    for (const [key, entry] of this.cacheStore.entries()) {
      const keyInfo = keyInfoFn(entry.sourceIndex);
      if (!keyInfo) {
        this.logger.warn(`Removing consolidation ${key} from cache because source validator is not Lido`);
        this.cacheStore.delete(key);
        continue;
      }
      // If a consolidation is past withdrawable epoch and no longer pending in state,
      // it has been processed in the transition and can be proved.
      let consolidationBlockRootToUse = entry.consolidationBlockRoot;
      if (!consolidationBlockRootToUse) {
        // Past withdrawable epoch and no longer pending means it was processed in the epoch transition.
        if (entry.withdrawableEpoch <= currentEpoch && !statePendingKeys.has(key)) {
          consolidationBlockRootToUse = consolidationBlockRoot;
          this.cacheStore.set(key, { ...entry, consolidationBlockRoot: consolidationBlockRootToUse });
        } else {
          continue;
        }
      }
      toProve.push({
        sourceIndex: entry.sourceIndex,
        targetIndex: entry.targetIndex,
        consolidationBlockRoot: consolidationBlockRootToUse,
        keyInfo,
      });
    }
    return toProve;
  }

  private async filterUnprovenConsolidations(toProve: ConsolidationToProve[]): Promise<ConsolidationToProve[]> {
    const unproven: ConsolidationToProve[] = [];
    for (const consolidation of toProve) {
      const proved = await this.csm.isWithdrawalProved(consolidation.keyInfo);
      if (proved) {
        this.logger.log(`Consolidation already proved for source validator ${consolidation.sourceIndex}`);
        this.cacheStore.delete(this.cacheStore.makeKey(consolidation.sourceIndex, consolidation.targetIndex));
        continue;
      }
      unproven.push(consolidation);
    }
    return unproven;
  }

  private groupConsolidationsByRoot(consolidations: ConsolidationToProve[]): Map<RootHex, ConsolidationToProve[]> {
    const grouped = new Map<RootHex, ConsolidationToProve[]>();
    for (const consolidation of consolidations) {
      const existing = grouped.get(consolidation.consolidationBlockRoot);
      if (existing) {
        existing.push(consolidation);
      } else {
        grouped.set(consolidation.consolidationBlockRoot, [consolidation]);
      }
    }
    return grouped;
  }

  private async getConsolidationProofContext(
    consolidationBlockRoot: RootHex,
    finalizedHeader: BlockHeaderResponse,
  ): Promise<ConsolidationProofContext | null> {
    const consolidationHeader = await this.consensus.getBeaconHeader(consolidationBlockRoot);
    const consolidationSlot = Number(consolidationHeader.header.message.slot);
    const summaryResolution = await resolveHistoricalSummaryContext(this.consensus, finalizedHeader, consolidationSlot);
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.BeforeCapella) {
      this.logger.warn(`Consolidation block ${consolidationBlockRoot} is before Capella fork slot`);
      return null;
    }
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.NotHistoricalYet) {
      this.logger.log(
        `Consolidation block ${consolidationBlockRoot} is not historical yet (summary slot ${summaryResolution.summarySlot})`,
      );
      return null;
    }
    const { summaryState, summaryIndex, rootIndexInSummary } = summaryResolution.context;
    const consolidationState = await this.consensus.getState(consolidationHeader.header.message.state_root);
    return {
      consolidationHeader,
      consolidationState,
      summaryState,
      summaryIndex,
      rootIndexInSummary,
    };
  }
}
