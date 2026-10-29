import { join } from 'node:path';

import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { Slot } from '@lodestar/types';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { ConfigService } from '../../common/config/config.service.js';
import { WorkingMode } from '../../common/config/env.validation.js';
import { type KeysRange, StakingModuleContract } from '../../common/contracts/staking-module-contract.service.js';
import { toRootHex } from '../../common/helpers/proofs.js';
import { getModuleStorageDir } from '../../common/helpers/storage.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import {
  METRIC_KEYS_CSM_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_ALL_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_STORAGE_STATE_SLOT,
  PrometheusService,
} from '../../common/prometheus/index.js';
import type { FullKeyInfo, KeyInfo } from '../../common/prover/types.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import type { SupportedBlock } from '../../common/providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../common/providers/consensus/response.interface.js';
import { WorkersService } from '../../common/workers/workers.service.js';

type KeysIndexerServiceInfo = {
  moduleAddress: string;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type KeysIndexerServiceStorage = {
  [valIndex: string]: KeyInfo;
};

@Injectable()
export class KeysIndexer implements OnApplicationBootstrap {
  private info: Low<KeysIndexerServiceInfo>;
  private storage: Low<KeysIndexerServiceStorage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly stakingModule: StakingModuleContract,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    this.setMetrics();
  }

  public getKey = (valIndex: number): KeyInfo | undefined => {
    return this.filterKeyInfo(this.storage.data[valIndex]);
  };

  public getAllKeys = (): KeysIndexerServiceStorage => {
    const filtered: KeysIndexerServiceStorage = {};

    for (const [valIndex, keyInfo] of Object.entries(this.storage.data)) {
      if (!this.filterKeyInfo(keyInfo)) continue;
      filtered[valIndex] = keyInfo;
    }

    return filtered;
  };

  public getFullKeyInfoByPubKey = (pubKey: string): FullKeyInfo | undefined => {
    for (const [validatorIndex, keyInfo] of Object.entries(this.storage.data)) {
      if (keyInfo.pubKey === pubKey) {
        return this.filterFullKeyInfo({
          operatorId: keyInfo.operatorId,
          keyIndex: keyInfo.keyIndex,
          pubKey,
          validatorIndex: Number(validatorIndex),
        });
      }
    }
    return undefined;
  };

  public isTimeToUpdate(finalizedHeader: BlockHeaderResponse): boolean {
    const slot = Number(finalizedHeader.header.message.slot);
    if (this.info.data.storageStateSlot == slot) {
      return false;
    }
    const storageTimestamp = this.consensus.slotToTimestamp(this.info.data.storageStateSlot) * 1000;
    return this.config.get('KEYS_INDEXER_RUNNING_PERIOD_MS') < Date.now() - storageTimestamp;
  }

  public async update(finalizedHeader: BlockHeaderResponse): Promise<void> {
    // We shouldn't wait for task to finish
    // to avoid block processing if indexing fails or stuck
    this.logger.log(`🔑 Keys indexer is running`);
    const finalizedSlot = Number(finalizedHeader.header.message.slot);
    const stateRoot = toRootHex(finalizedHeader.header.message.stateRoot);
    const finalizedBlock = await this.consensus.getBlockInfo(finalizedHeader.root);
    const blockNumber = finalizedBlock.body.executionPayload.blockNumber;
    // EL is read before the state download so that an EL failure does not cost a state download
    const keysMap = await this.readNewKeys(blockNumber);

    this.logger.log(`Get validators. State root [${stateRoot}]`);
    const state = await this.consensus.getState(stateRoot);
    const lastValidatorsCount = this.info.data.lastValidatorsCount;
    const { totalValLength, valKeys } = await this.workers.getNewValidatorKeys({ state, lastValidatorsCount });
    this.logger.log(`Total validators count: ${totalValLength}, new: ${valKeys.length}`);
    // Build first, then assign atomically — no partial state visible to concurrent readers.
    const newEntries: KeysIndexerServiceStorage = {};
    valKeys.forEach((pubKey, i) => {
      const keyInfo = keysMap.get(pubKey);
      if (!keyInfo) return;
      newEntries[lastValidatorsCount + i] = keyInfo;
    });
    Object.assign(this.storage.data, newEntries);
    this.logger.log(`Staking module validators count: ${Object.keys(this.storage.data).length}`);
    this.info.data.storageStateSlot = finalizedSlot;
    this.info.data.lastValidatorsCount = totalValLength;
    await this.storage.write();
    await this.info.write();
  }

  private async readNewKeys(blockNumber: number): Promise<Map<string, KeyInfo>> {
    const allowedIds = this.config.get('DAEMON_NODE_OPERATOR_IDS');
    const operatorIds = allowedIds?.length
      ? allowedIds
      : Array.from({ length: await this.stakingModule.getNodeOperatorsCount(blockNumber) }, (_, i) => i);

    // Keys are deposited in index order and never change after that, so keys below the cursor are already indexed
    const cursors = new Map<number, number>();
    for (const { operatorId, keyIndex } of Object.values(this.storage.data)) {
      cursors.set(operatorId, Math.max(cursors.get(operatorId) ?? 0, keyIndex + 1));
    }

    const depositedCounts = await this.stakingModule.getDepositedKeysCounts(operatorIds, blockNumber);
    const ranges: KeysRange[] = [];
    operatorIds.forEach((operatorId, i) => {
      const from = cursors.get(operatorId) ?? 0;
      const deposited = depositedCounts[i];
      if (deposited < from) {
        throw new Error(`Operator ${operatorId} has ${deposited} deposited keys, but the key ${from - 1} is indexed`);
      }
      if (deposited > from) ranges.push({ operatorId, from, to: deposited });
    });

    const keys = await this.stakingModule.getDepositedKeys(ranges, blockNumber);
    this.logger.log(`Read ${keys.length} deposited keys of ${operatorIds.length} operators`);
    const keysMap = new Map<string, KeyInfo>();
    for (const key of keys) keysMap.set(key.pubKey, key);
    return keysMap;
  }

  // Validators are appended to the state in index order, so every index below `lastValidatorsCount` was
  // looked up during the last scan. A higher one appeared after it and cannot be judged yet.
  public isTrustedForBlock(blockInfo: SupportedBlock): boolean {
    const maxIndex = this.maxReferencedValidatorIndex(blockInfo);
    const indexed = this.info.data.lastValidatorsCount;
    if (maxIndex < indexed) return true;
    this.logger.warn(
      `🚨 Block references validator ${maxIndex}, beyond the indexed ${indexed}. The root will be processed later again`,
    );
    return false;
  }

  public isTrustedForSlot(slotNumber: Slot): boolean {
    return this.info.data.storageStateSlot >= slotNumber;
  }

  private maxReferencedValidatorIndex(blockInfo: SupportedBlock): number {
    let max = -1;
    for (const wd of blockInfo.body.executionPayload.withdrawals) max = Math.max(max, Number(wd.validatorIndex));
    for (const prop of blockInfo.body.proposerSlashings) {
      max = Math.max(max, Number(prop.signedHeader1.message.proposerIndex));
    }
    for (const att of blockInfo.body.attesterSlashings) {
      // The duty slashes the intersection; the union is a cheaper and safely conservative bound.
      for (const i of att.attestation1.attestingIndices) max = Math.max(max, Number(i));
      for (const i of att.attestation2.attestingIndices) max = Math.max(max, Number(i));
    }
    return max;
  }

  private filterKeyInfo(keyInfo: KeyInfo | undefined): KeyInfo | undefined {
    if (!keyInfo || !this.isAllowedOperatorId(keyInfo.operatorId)) {
      return undefined;
    }

    return keyInfo;
  }

  private filterFullKeyInfo(fullKeyInfo: FullKeyInfo | undefined): FullKeyInfo | undefined {
    if (!fullKeyInfo || !this.isAllowedOperatorId(fullKeyInfo.operatorId)) {
      return undefined;
    }

    return fullKeyInfo;
  }

  public isInitialized(): boolean {
    return (this.info?.data?.storageStateSlot ?? 0) > 0;
  }

  public async initOrReadServiceData() {
    const moduleAddress = this.config.get('STAKING_MODULE_ADDRESS');
    const storageDir = getModuleStorageDir(moduleAddress);
    const defaultInfo: KeysIndexerServiceInfo = {
      moduleAddress,
      storageStateSlot: 0,
      lastValidatorsCount: 0,
    };
    this.info = new Low<KeysIndexerServiceInfo>(
      new JSONFile<KeysIndexerServiceInfo>(join(storageDir, 'keys-indexer-info.json')),
      defaultInfo,
    );
    this.storage = new Low<KeysIndexerServiceStorage>(
      new JSONFile<KeysIndexerServiceStorage>(join(storageDir, 'keys-indexer-storage.json')),
      {},
    );
    await this.info.read();
    await this.storage.read();

    if (this.info.data.storageStateSlot == 0) {
      this.logger.log(`Init keys data`);
      await this.update(await this.consensus.getBeaconHeader('finalized'));
    }
  }

  private setMetrics() {
    const info = () => this.info.data;
    const keysCount = () => Object.keys(this.storage.data).length;
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_KEYS_INDEXER_STORAGE_STATE_SLOT,
      help: 'Keys indexer storage state slot',
      labelNames: [],
      collect() {
        this.set(info().storageStateSlot);
      },
    });
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_KEYS_INDEXER_ALL_VALIDATORS_COUNT,
      help: 'Keys indexer all validators count',
      labelNames: [],
      collect() {
        this.set(info().lastValidatorsCount);
      },
    });
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_KEYS_CSM_VALIDATORS_COUNT,
      help: 'Keys indexer CSM validators count',
      labelNames: [],
      collect() {
        this.set(keysCount());
      },
    });
  }

  private isAllowedOperatorId(operatorId: number): boolean {
    if (this.config.get('WORKING_MODE') !== WorkingMode.Daemon) {
      return true;
    }

    const allowedOperatorIds = this.config.get('DAEMON_NODE_OPERATOR_IDS');
    if (!allowedOperatorIds?.length) {
      return true;
    }

    return allowedOperatorIds.includes(operatorId);
  }
}
