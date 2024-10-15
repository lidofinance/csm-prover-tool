import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';
import { BooleanType, ByteVectorType, ContainerNodeStructType, UintNumberType } from '@chainsafe/ssz';
import { ListCompositeTreeView } from '@chainsafe/ssz/lib/view/listComposite';
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
  TrackTask,
} from '../../common/prometheus';
import { toHex } from '../../common/prover/helpers/proofs';
import { KeyInfo } from '../../common/prover/types';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex, Slot } from '../../common/providers/consensus/response.interface';
import { Keysapi } from '../../common/providers/keysapi/keysapi';
import { Key, Module } from '../../common/providers/keysapi/response.interface';

type KeysIndexerServiceInfo = {
  moduleAddress: string;
  moduleId: number;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type KeysIndexerServiceStorage = {
  [valIndex: number]: KeyInfo;
};

type Validators = ListCompositeTreeView<
  ContainerNodeStructType<{
    pubkey: ByteVectorType;
    withdrawalCredentials: ByteVectorType;
    effectiveBalance: UintNumberType;
    slashed: BooleanType;
    activationEligibilityEpoch: UintNumberType;
    activationEpoch: UintNumberType;
    exitEpoch: UintNumberType;
    withdrawableEpoch: UintNumberType;
  }>
>;

// At one time only one task should be running
function Single(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;
  descriptor.value = function (...args: any[]) {
    if (this.startedAt > 0) {
      this.logger.warn(`🔑 Keys indexer has been running for ${Date.now() - this.startedAt}ms`);
      return;
    }
    originalMethod.apply(this, args);
  };
  return descriptor;
}

export class ModuleNotFoundError extends Error {}

@Injectable()
export class KeysIndexer implements OnApplicationBootstrap {
  public MODULE_NOT_FOUND_NEXT_TRY_MS = 60000;

  // it actually used by `Single` decorator
  private startedAt: number = 0;

  private info: Low<KeysIndexerServiceInfo>;
  private storage: Low<KeysIndexerServiceStorage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly keysapi: Keysapi,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    this.setMetrics();
  }

  public getKey = (valIndex: number): KeyInfo | undefined => {
    return this.storage.data[valIndex];
  };

  @Single
  public update(finalizedHeader: BlockHeaderResponse): void {
    // TODO: do we have to check integrity of data here? when `this.info` says one thing and `this.storage` another
    const slot = Number(finalizedHeader.header.message.slot);
    if (this.isNotTimeToRun(slot)) {
      this.logger.log('No need to run keys indexer');
      return;
    }
    const stateRoot = finalizedHeader.header.message.state_root;
    // We shouldn't wait for task to finish
    // to avoid block processing if indexing fails or stuck
    this.startedAt = Date.now();
    this.baseRun(
      stateRoot,
      slot,
      async (validators, finalizedSlot) => await this.updateStorage(validators, finalizedSlot),
    )
      .catch((e) => this.logger.error(e))
      .finally(() => (this.startedAt = 0));
  }

  @TrackTask('update-keys-indexer')
  private async baseRun(
    stateRoot: RootHex,
    finalizedSlot: Slot,
    stateDataProcessingCallback: (validators: Validators, finalizedSlot: Slot) => Promise<void>,
  ): Promise<void> {
    this.logger.log(`🔑 Keys indexer is running`);
    this.logger.log(`Get validators. State root [${stateRoot}]`);
    const state = await this.consensus.getState(stateRoot);
    const stateView = this.consensus.stateToView(state.bodyBytes, state.forkName);
    this.logger.log(`Total validators count: ${stateView.validators.length}`);
    // TODO: do we need to store already full withdrawn keys ?
    const currValidatorsCount = stateView.validators.length;
    await stateDataProcessingCallback(stateView.validators, finalizedSlot);
    this.logger.log(`CSM validators count: ${Object.keys(this.storage.data).length}`);
    this.info.data.storageStateSlot = finalizedSlot;
    this.info.data.lastValidatorsCount = currValidatorsCount;
    await this.info.write();
    await this.storage.write();
  }

  public isNotTimeToRun(finalizedSlot: Slot): boolean {
    const storageTimestamp = this.consensus.slotToTimestamp(this.info.data.storageStateSlot) * 1000;
    return (
      this.info.data.storageStateSlot == finalizedSlot ||
      this.config.get('KEYS_INDEXER_RUNNING_PERIOD_MS') >= Date.now() - storageTimestamp
    );
  }

  public isTrustedForAnyDuty(slotNumber: Slot): boolean {
    return this.isTrustedForSlashings(slotNumber) || this.isTrustedForFullWithdrawals(slotNumber);
  }

  public isTrustedForEveryDuty(slotNumber: Slot): boolean {
    const trustedForSlashings = this.isTrustedForSlashings(slotNumber);
    const trustedForFullWithdrawals = this.isTrustedForFullWithdrawals(slotNumber);
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
    return trustedForSlashings && trustedForFullWithdrawals;
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
        throw new ModuleNotFoundError(
          `Module with address ${this.info.data.moduleAddress} not found! ` +
            'Update configs if this is the wrong address. Next automatic attempt to find it will be in 1m',
        );
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
        async (validators, finalizedSlot) => await this.initStorage(validators, finalizedSlot),
      );
    }
  }

  private async initStorage(validators: Validators, finalizedSlot: Slot): Promise<void> {
    const csmKeys = await this.keysapi.getModuleKeys(this.info.data.moduleId);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    const keysMap = new Map<string, { operatorIndex: number; index: number }>();
    csmKeys.data.keys.forEach((k: Key) => keysMap.set(k.key, { ...k }));
    const valLength = validators.length;
    const iterator = iterateNodesAtDepth(
      validators.type.tree_getChunksNode(validators.node),
      validators.type.chunkDepth,
      0,
      valLength,
    );
    for (let i = 0; i < valLength; i++) {
      const node = iterator.next().value;
      const v = node.value;
      const pubKey = toHex(v.pubkey);
      const keyInfo = keysMap.get(pubKey);
      if (!keyInfo) continue;
      this.storage.data[i] = {
        operatorId: keyInfo.operatorIndex,
        keyIndex: keyInfo.index,
        pubKey: pubKey,
      };
    }
    iterator.return && iterator.return();
  }

  private async updateStorage(validators: Validators, finalizedSlot: Slot): Promise<void> {
    // TODO: should we think about re-using validator indexes?
    // TODO: should we think about changing WC for existing old vaidators ?
    const valLength = validators.length;
    const appearedValsCount = valLength - this.info.data.lastValidatorsCount;
    if (appearedValsCount == 0) {
      this.logger.log(`No new validators in the state`);
      return;
    }
    this.logger.log(`New appeared validators count: ${appearedValsCount}`);
    const iterator = iterateNodesAtDepth(
      validators.type.tree_getChunksNode(validators.node),
      validators.type.chunkDepth,
      this.info.data.lastValidatorsCount,
      appearedValsCount,
    );
    const valKeys = [];
    for (let i = this.info.data.lastValidatorsCount; i < valLength; i++) {
      const node = iterator.next().value;
      const v = validators.type.elementType.tree_toValue(node);
      valKeys.push(toHex(v.pubkey));
    }
    // TODO: can be better
    const csmKeys = await this.keysapi.findModuleKeys(this.info.data.moduleId, valKeys);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    this.logger.log(`New appeared CSM validators count: ${csmKeys.data.keys.length}`);
    const valKeysLength = valKeys.length;
    for (const csmKey of csmKeys.data.keys) {
      for (let i = 0; i < valKeysLength; i++) {
        if (valKeys[i] != csmKey.key) continue;
        const index = i + this.info.data.lastValidatorsCount;
        this.storage.data[index] = {
          operatorId: csmKey.operatorIndex,
          keyIndex: csmKey.index,
          pubKey: csmKey.key,
        };
      }
    }
    iterator.return && iterator.return();
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
