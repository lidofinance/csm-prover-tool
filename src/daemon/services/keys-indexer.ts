import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnApplicationBootstrap } from '@nestjs/common';

import { ConfigService } from '../../common/config/config.service';
import {
  METRIC_KEYS_CSM_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_ALL_VALIDATORS_COUNT,
  METRIC_KEYS_INDEXER_STORAGE_STATE_SLOT,
  PrometheusService,
} from '../../common/prometheus';
import { FullKeyInfo, KeyInfo } from '../../common/prover/types';
import { Consensus, State } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex, Slot } from '../../common/providers/consensus/response.interface';
import { Keysapi } from '../../common/providers/keysapi/keysapi';
import { Key, Module } from '../../common/providers/keysapi/response.interface';
import { WorkersService } from '../../common/workers/workers.service';
import sleep from '../utils/sleep';

type KeysIndexerServiceInfo = {
  moduleAddress: string;
  moduleId: number;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type KeysIndexerServiceStorage = {
  [valIndex: number]: KeyInfo;
};

export class ModuleNotFoundError extends Error {}

@Injectable()
export class KeysIndexer implements OnApplicationBootstrap {
  public MODULE_NOT_FOUND_NEXT_TRY_MS = 60000;

  private info: Low<KeysIndexerServiceInfo>;
  private storage: Low<KeysIndexerServiceStorage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
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
    return this.storage.data[valIndex];
  };

  public getFullKeyInfoByPubKey = (pubKey: string): FullKeyInfo | undefined => {
    for (const [validatorIndex, keyInfo] of Object.entries(this.storage.data)) {
      if (keyInfo.pubKey === pubKey) {
        return {
          operatorId: keyInfo.operatorId,
          keyIndex: keyInfo.keyIndex,
          pubKey,
          validatorIndex: Number(validatorIndex),
        };
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
    const stateRoot = finalizedHeader.header.message.state_root;
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
    return this.isTrustedForFullWithdrawals(slotNumber);
  }

  public isTrustedForEveryDuty(slotNumber: Slot): boolean {
    const trustedForFullWithdrawals = this.isTrustedForFullWithdrawals(slotNumber);
    if (!trustedForFullWithdrawals)
      this.logger.warn(
        '⚠️ Current keys indexer data might not be ready to detect full withdrawal. ' +
          'The root will be processed later again',
      );
    return trustedForFullWithdrawals;
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
      const stateRoot = finalized.header.message.state_root;
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
}
