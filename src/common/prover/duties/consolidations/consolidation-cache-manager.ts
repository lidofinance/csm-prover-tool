import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';

import { ConsolidationToProve } from './consolidations.types';
import { CsmContract } from '../../../contracts/csm-contract.service';
import { RootHex } from '../../../providers/consensus/response.interface';
import type { PendingConsolidationInfo } from '../../../workers/items/inspect-pending-consolidations';
import {
  ConsolidationCacheStore,
  ConsolidationKey,
  NoopConsolidationCacheStore,
  PersistentConsolidationCacheStore,
} from '../../cache/consolidation-cache-store';
import { KeyInfoFn } from '../../types';

@Injectable()
export class ConsolidationCacheManager implements OnModuleInit {
  private readonly cacheStore: ConsolidationCacheStore;

  constructor(
    @Inject(LOGGER_PROVIDER) private readonly logger: LoggerService,
    private readonly csm: CsmContract,
    @Optional() cacheStore?: PersistentConsolidationCacheStore,
  ) {
    this.cacheStore = cacheStore ?? new NoopConsolidationCacheStore();
  }

  public async onModuleInit(): Promise<void> {
    await this.cacheStore.ensureReady();
  }

  public syncFromState(statePending: PendingConsolidationInfo[], keyInfoFn: KeyInfoFn): Set<ConsolidationKey> {
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
    this.logger.log(
      `Synced pending consolidations from state: All=${statePending.length}, Lido-only=${statePendingKeys.size}`,
    );
    return statePendingKeys;
  }

  public collectToProve(
    statePendingKeys: Set<ConsolidationKey>,
    currentEpoch: number,
    consolidationBlockRoot: RootHex,
    keyInfoFn: KeyInfoFn,
  ): ConsolidationToProve[] {
    const toProve: ConsolidationToProve[] = [];
    for (const [key, entry] of this.cacheStore.entries()) {
      const keyInfo = keyInfoFn(entry.sourceIndex);
      if (!keyInfo) {
        throw new Error(`Key info not found for source validator index ${entry.sourceIndex}`);
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

  public async filterUnproven(consolidations: ConsolidationToProve[]): Promise<ConsolidationToProve[]> {
    const unproven: ConsolidationToProve[] = [];
    for (const consolidation of consolidations) {
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

  public async flush(): Promise<void> {
    await this.cacheStore.flushIfPendingWrite();
  }
}
