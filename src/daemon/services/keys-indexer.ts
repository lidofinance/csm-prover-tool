import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex, Slot } from '@lodestar/types';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { ConfigService } from '../../common/config/config.service.js';
import { WorkingMode } from '../../common/config/env.validation.js';
import { toRootHex } from '../../common/helpers/proofs.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import {
  METRIC_KEYS_CSM_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_ALL_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_STORAGE_STATE_SLOT,
  PrometheusService,
} from '../../common/prometheus/index.js';
import type { FullKeyInfo, KeyInfo } from '../../common/prover/types.js';
import { Consensus, type State } from '../../common/providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../common/providers/consensus/response.interface.js';
import { Keysapi } from '../../common/providers/keysapi/keysapi.js';
import type { Key, Module } from '../../common/providers/keysapi/response.interface.js';
import { WorkersService } from '../../common/workers/workers.service.js';
import sleep from '../utils/sleep.js';

type KeysIndexerServiceInfo = {
  moduleAddress: string;
  moduleId: number;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type KeysIndexerServiceStorage = {
  [valIndex: string]: KeyInfo;
};

export class ModuleNotFoundError extends Error {}

@Injectable()
export class KeysIndexer implements OnApplicationBootstrap {
  public MODULE_NOT_FOUND_NEXT_TRY_MS = 60000;

  private info: Low<KeysIndexerServiceInfo>;
  private storage: Low<KeysIndexerServiceStorage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly keysapi: Keysapi,
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
    // TODO: do we have to check integrity of data here? when `this.info` says one thing and `this.storage` another
    const storageTimestamp = this.consensus.slotToTimestamp(this.info.data.storageStateSlot) * 1000;
    return this.config.get('KEYS_INDEXER_RUNNING_PERIOD_MS') < Date.now() - storageTimestamp;
  }

  public async update(finalizedHeader: BlockHeaderResponse): Promise<void> {
    const slot = Number(finalizedHeader.header.message.slot);
    const stateRoot = toRootHex(finalizedHeader.header.message.stateRoot);
    // We shouldn't wait for task to finish
    // to avoid block processing if indexing fails or stuck
    await this.baseRun(
      stateRoot,
      slot,
      async (validators, finalizedSlot) => await this.updateStorage(validators, finalizedSlot),
    );
  }

  private async baseRun(
    stateRoot: RootHex,
    finalizedSlot: Slot,
    stateDataProcessingCallback: (state: State, finalizedSlot: Slot) => Promise<number>,
  ): Promise<void> {
    this.logger.log(`🔑 Keys indexer is running`);
    this.logger.log(`Get validators. State root [${stateRoot}]`);
    const state = await this.consensus.getState(stateRoot);
    // TODO: do we need to store already full withdrawn keys ?
    const totalValLength = await stateDataProcessingCallback(state, finalizedSlot);
    this.logger.log(`CSM validators count: ${Object.keys(this.storage.data).length}`);
    this.info.data.storageStateSlot = finalizedSlot;
    this.info.data.lastValidatorsCount = totalValLength;
    await this.info.write();
    await this.storage.write();
  }

  public isTrustedForAnyDuty(slotNumber: Slot): boolean {
    return (
      this.isTrustedForBalanceChanges(slotNumber) ||
      this.isTrustedForSlashings(slotNumber) ||
      this.isTrustedForFullWithdrawals(slotNumber)
    );
  }

  public isTrustedForEveryDuty(slotNumber: Slot): boolean {
    const trustedForBalanceChanges = this.isTrustedForBalanceChanges(slotNumber);
    const trustedForSlashings = this.isTrustedForSlashings(slotNumber);
    const trustedForFullWithdrawals = this.isTrustedForFullWithdrawals(slotNumber);
    if (!trustedForBalanceChanges)
      this.logger.warn(
        '⚠️ Current keys indexer data might not be ready to detect balance changes. ' +
          'The root will be processed later again',
      );
    if (!trustedForSlashings)
      this.logger.warn(
        '🚨 Current keys indexer data might not be ready to detect slashing. ' +
          'The root will be processed later again',
      );
    if (!trustedForFullWithdrawals)
      this.logger.warn(
        '⚠️ Current keys indexer data might not be ready to detect full withdrawal. ' +
          'The root will be processed later again',
      );
    return trustedForBalanceChanges && trustedForSlashings && trustedForFullWithdrawals;
  }

  public isTrustedForBalanceChanges(slotNumber: Slot): boolean {
    return this.isTrustedForFullWithdrawals(slotNumber);
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

  private isTrustedForSlashings(slotNumber: Slot): boolean {
    // We are ok with outdated indexer for detection slashing
    // because of a bunch of delays between deposit and validator appearing
    const ETH1_FOLLOW_DISTANCE = Number(this.consensus.beaconConfig.ETH1_FOLLOW_DISTANCE); // ~8 hours
    const EPOCHS_PER_ETH1_VOTING_PERIOD = Number(this.consensus.beaconConfig.EPOCHS_PER_ETH1_VOTING_PERIOD); // ~6.8 hours
    const safeDelay = ETH1_FOLLOW_DISTANCE + this.consensus.epochToSlot(EPOCHS_PER_ETH1_VOTING_PERIOD);
    if (this.info.data.storageStateSlot >= slotNumber) return true;
    return slotNumber - this.info.data.storageStateSlot <= safeDelay; // ~14.8 hours
  }

  private isTrustedForFullWithdrawals(slotNumber: Slot): boolean {
    // We are ok with outdated indexer for detection withdrawal
    // because of MIN_VALIDATOR_WITHDRAWABILITY_DELAY
    const MIN_VALIDATOR_WITHDRAWABILITY_DELAY = Number(this.consensus.beaconConfig.MIN_VALIDATOR_WITHDRAWABILITY_DELAY);
    const safeDelay = this.consensus.epochToSlot(MIN_VALIDATOR_WITHDRAWABILITY_DELAY);
    if (this.info.data.storageStateSlot >= slotNumber) return true;
    return slotNumber - this.info.data.storageStateSlot <= safeDelay; // ~27 hours
  }

  public isInitialized(): boolean {
    return Boolean(
      this.info?.data?.moduleId && this.info?.data?.storageStateSlot && this.info?.data?.lastValidatorsCount,
    );
  }

  public async initOrReadServiceData() {
    const defaultInfo: KeysIndexerServiceInfo = {
      moduleAddress: this.config.get('CSM_ADDRESS'),
      moduleId: 0,
      storageStateSlot: 0,
      lastValidatorsCount: 0,
    };
    this.info = new Low<KeysIndexerServiceInfo>(
      new JSONFile<KeysIndexerServiceInfo>('storage/keys-indexer-info.json'),
      defaultInfo,
    );
    this.storage = new Low<KeysIndexerServiceStorage>(
      new JSONFile<KeysIndexerServiceStorage>('storage/keys-indexer-storage.json'),
      {},
    );
    await this.info.read();
    await this.storage.read();

    if (this.info.data.moduleId == 0) {
      const modulesResp = await this.keysapi.getModules();
      const module = modulesResp.data.find(
        (m: Module) => m.stakingModuleAddress.toLowerCase() === this.info.data.moduleAddress.toLowerCase(),
      );
      if (!module) {
        const error = new ModuleNotFoundError(
          `Module with address ${this.info.data.moduleAddress} not found! ` +
            'Update configs if this is the wrong address. Next automatic attempt to find it will be in 1m',
        );
        this.logger.error(error.message);
        await sleep(this.MODULE_NOT_FOUND_NEXT_TRY_MS);
        throw error;
      }
      this.info.data.moduleId = module.id;
      await this.info.write();
    }

    if (this.info.data.storageStateSlot == 0 || this.info.data.lastValidatorsCount == 0) {
      this.logger.log(`Init keys data`);
      const finalized = await this.consensus.getBeaconHeader('finalized');
      const finalizedSlot = Number(finalized.header.message.slot);
      const stateRoot = toRootHex(finalized.header.message.stateRoot);
      await this.baseRun(
        stateRoot,
        finalizedSlot,
        async (state, finalizedSlot): Promise<number> => await this.initStorage(state, finalizedSlot),
      );
    }
  }

  private async initStorage(state: State, finalizedSlot: Slot): Promise<number> {
    const csmKeys = await this.keysapi.getModuleKeys(this.info.data.moduleId);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    const keysMap = new Map<string, { operatorIndex: number; index: number }>();
    csmKeys.data.keys.forEach((k: Key) => keysMap.set(k.key, { ...k }));
    const { totalValLength, valKeys } = await this.workers.getNewValidatorKeys({
      state,
      lastValidatorsCount: 0,
    });
    this.logger.log(`Total validators count: ${totalValLength}`);
    for (let i = 0; i < totalValLength; i++) {
      const pubKey = valKeys[i];
      const keyInfo = keysMap.get(pubKey);
      if (!keyInfo) continue;
      this.storage.data[i] = {
        operatorId: keyInfo.operatorIndex,
        keyIndex: keyInfo.index,
        pubKey: pubKey,
      };
    }
    return totalValLength;
  }

  private async updateStorage(state: State, finalizedSlot: Slot): Promise<number> {
    // TODO: should we think about re-using validator indexes?
    // TODO: should we think about changing WC for existing old vaidators ?
    const { totalValLength, valKeys: newValKeys } = await this.workers.getNewValidatorKeys({
      state,
      lastValidatorsCount: this.info.data.lastValidatorsCount,
    });
    this.logger.log(`Total validators count: ${totalValLength}`);
    if (newValKeys.length == 0) {
      this.logger.log(`No new validators in the state`);
      return totalValLength;
    }
    this.logger.log(`New appeared validators count: ${newValKeys.length}`);
    const csmKeys = await this.keysapi.findModuleKeys(this.info.data.moduleId, newValKeys);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    this.logger.log(`New appeared CSM validators count: ${csmKeys.data.keys.length}`);
    const valKeysLength = newValKeys.length;
    for (const csmKey of csmKeys.data.keys) {
      for (let i = 0; i < valKeysLength; i++) {
        if (newValKeys[i] != csmKey.key || !csmKey.used) continue;
        const index = i + this.info.data.lastValidatorsCount;
        this.storage.data[index] = {
          operatorId: csmKey.operatorIndex,
          keyIndex: csmKey.index,
          pubKey: csmKey.key,
        };
      }
    }
    return totalValLength;
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
