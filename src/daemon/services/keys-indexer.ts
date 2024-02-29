import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';
import { BooleanType, ByteVectorType, ContainerNodeStructType, UintNumberType } from '@chainsafe/ssz';
import { ListCompositeTreeView } from '@chainsafe/ssz/lib/view/listComposite';
import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '../../common/config/config.service';
import { KeyInfo } from '../../common/handlers/handlers.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex, Slot } from '../../common/providers/consensus/response.interface';
import { Keysapi } from '../../common/providers/keysapi/keysapi';
import { Key, Module } from '../../common/providers/keysapi/response.interface';

type Info = {
  moduleAddress: string;
  moduleId: number;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type Storage = {
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

@Injectable()
export class KeysIndexer implements OnModuleInit {
  private startedAt: number = 0;

  private info: Low<Info>;
  private storage: Low<Storage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly keysapi: Keysapi,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.initOrReadServiceData();
  }

  public getKey = (valIndex: number): KeyInfo | undefined => {
    return this.storage.data[valIndex];
  };

  @Single
  public async update(finalizedHeader: BlockHeaderResponse): Promise<void> {
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
    this.baseRun(stateRoot, slot, this.updateStorage)
      .catch((e) => this.logger.error(e))
      .finally(() => (this.startedAt = 0));
  }

  private async baseRun(
    stateRoot: RootHex,
    finalizedSlot: Slot,
    stateDataProcessingCallback: (validators: Validators, finalizedSlot: Slot) => Promise<void>,
  ): Promise<void> {
    this.logger.log(`🔑 Keys indexer is running`);
    this.logger.log(`Get validators. State root [${stateRoot}]`);
    const stateView = await this.consensus.getStateView(stateRoot);
    this.logger.log(`Total validators count: ${stateView.validators.length}`);
    // TODO: do we need to store already full withdrawn keys ?
    await stateDataProcessingCallback(stateView.validators, finalizedSlot);
    this.logger.log(`CSM validators count: ${Object.keys(this.storage.data).length}`);
    this.info.data.storageStateSlot = finalizedSlot;
    this.info.data.lastValidatorsCount = stateView.validators.length;
    await this.info.write();
    await this.storage.write();
  }

  public isNotTimeToRun(finalizedSlot: Slot): boolean {
    const storageTimestamp = this.consensus.slotToTimestamp(this.info.data.storageStateSlot) * 1000;
    return (
      this.info.data.storageStateSlot == finalizedSlot ||
      this.config.get('KEYS_INDEXER_RUNNING_PERIOD') >= Date.now() - storageTimestamp
    );
  }

  public eligibleForAnyDuty(slotNumber: Slot): boolean {
    return this.eligibleForSlashings(slotNumber) || this.eligibleForFullWithdrawals(slotNumber);
  }

  public eligibleForEveryDuty(slotNumber: Slot): boolean {
    const eligibleForSlashings = this.eligibleForSlashings(slotNumber);
    const eligibleForFullWithdrawals = this.eligibleForFullWithdrawals(slotNumber);
    if (!eligibleForSlashings)
      this.logger.warn(
        '🚨 Current keys indexer data might not be ready to detect slashing. ' +
          'The root will be processed later again',
      );
    if (!eligibleForFullWithdrawals)
      this.logger.warn(
        '⚠️ Current keys indexer data might not be ready to detect full withdrawal. ' +
          'The root will be processed later again',
      );
    return eligibleForSlashings && eligibleForFullWithdrawals;
  }

  private eligibleForSlashings(slotNumber: Slot): boolean {
    // We are ok with oudated indexer for detection slasing
    // because of a bunch of delays between deposit and validator appearing
    // TODO: get constants from node
    const ETH1_FOLLOW_DISTANCE = 2048; // ~8 hours
    const EPOCHS_PER_ETH1_VOTING_PERIOD = 64; // ~6.8 hours
    const safeDelay = ETH1_FOLLOW_DISTANCE + EPOCHS_PER_ETH1_VOTING_PERIOD * 32;
    if (this.info.data.storageStateSlot >= slotNumber) return true;
    return slotNumber - this.info.data.storageStateSlot <= safeDelay; // ~14.8 hours
  }

  private eligibleForFullWithdrawals(slotNumber: Slot): boolean {
    // We are ok with oudated indexer for detection withdrawal
    // because of MIN_VALIDATOR_WITHDRAWABILITY_DELAY
    // TODO: get constants from node
    const MIN_VALIDATOR_WITHDRAWABILITY_DELAY = 256;
    const safeDelay = MIN_VALIDATOR_WITHDRAWABILITY_DELAY * 32;
    if (this.info.data.storageStateSlot >= slotNumber) return true;
    return slotNumber - this.info.data.storageStateSlot <= safeDelay; // ~27 hours
  }

  private async initOrReadServiceData() {
    const defaultInfo: Info = {
      moduleAddress: this.config.get('LIDO_STAKING_MODULE_ADDRESS'),
      moduleId: 0,
      storageStateSlot: 0,
      lastValidatorsCount: 0,
    };
    this.info = new Low<Info>(new JSONFile<Info>('.keys-indexer-info.json'), defaultInfo);
    this.storage = new Low<Storage>(new JSONFile<Storage>('.keys-indexer-storage.json'), {});
    await this.info.read();
    await this.storage.read();

    if (this.info.data.moduleId == 0) {
      const modulesResp = await this.keysapi.getModules();
      const module = modulesResp.data.find(
        (m: Module) => m.stakingModuleAddress.toLowerCase() === this.info.data.moduleAddress.toLowerCase(),
      );
      if (!module) {
        throw new Error(`Module with address ${this.info.data.moduleAddress} not found`);
      }
      this.info.data.moduleId = module.id;
      await this.info.write();
    }

    if (this.info.data.storageStateSlot == 0 || this.info.data.lastValidatorsCount == 0) {
      this.logger.log(`Init keys data`);
      const finalized = await this.consensus.getBeaconHeader('finalized');
      const finalizedSlot = Number(finalized.header.message.slot);
      const stateRoot = finalized.header.message.state_root;
      await this.baseRun(stateRoot, finalizedSlot, this.initStorage);
    }
  }

  initStorage = async (validators: Validators, finalizedSlot: Slot): Promise<void> => {
    const csmKeys = await this.keysapi.getModuleKeys(this.info.data.moduleId);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    const keysMap = new Map<string, { operatorIndex: number; index: number }>();
    csmKeys.data.keys.forEach((k: Key) => keysMap.set(k.key, { ...k }));
    const iterator = iterateNodesAtDepth(
      validators.type.tree_getChunksNode(validators.node),
      validators.type.chunkDepth,
      0,
      validators.length,
    );
    for (let i = 0; i < validators.length; i++) {
      const node = iterator.next().value;
      const v = validators.type.elementType.tree_toValue(node);
      const pubKey = '0x'.concat(Buffer.from(v.pubkey).toString('hex'));
      const keyInfo = keysMap.get(pubKey);
      if (!keyInfo) continue;
      this.storage.data[i] = {
        operatorId: keyInfo.operatorIndex,
        keyIndex: keyInfo.index,
        pubKey: pubKey,
        // TODO: bigint?
        withdrawableEpoch: v.withdrawableEpoch,
      };
    }
  };

  updateStorage = async (validators: Validators, finalizedSlot: Slot): Promise<void> => {
    // TODO: should we think about re-using validator indexes?
    // TODO: should we think about changing WC for existing old vaidators ?
    const appearedValsCount = validators.length - this.info.data.lastValidatorsCount;
    if (appearedValsCount == 0) {
      this.logger.log(`No new validators in the state`);
      return;
    }
    this.logger.log(`New appeared validators count: ${appearedValsCount}`);
    const iterator = iterateNodesAtDepth(
      validators.type.tree_getChunksNode(validators.node),
      validators.type.chunkDepth,
      this.info.data.lastValidatorsCount - 1,
      validators.length,
    );
    const valKeys = [];
    const valWithdrawableEpochs = [];
    for (let i = this.info.data.lastValidatorsCount - 1; i < validators.length; i++) {
      const node = iterator.next().value;
      const v = validators.type.elementType.tree_toValue(node);
      valKeys.push('0x'.concat(Buffer.from(v.pubkey).toString('hex')));
      valWithdrawableEpochs.push(v.withdrawableEpoch);
    }
    // TODO: can be better
    const csmKeys = await this.keysapi.findModuleKeys(this.info.data.moduleId, valKeys);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    this.logger.log(`New appeared CSM validators count: ${csmKeys.data.keys.length}`);
    for (const csmKey of csmKeys.data.keys) {
      for (let i = 0; i < valKeys.length; i++) {
        if (valKeys[i] != csmKey.key) continue;
        const index = i + this.info.data.lastValidatorsCount;
        this.storage.data[index] = {
          operatorId: csmKey.operatorIndex,
          keyIndex: csmKey.index,
          pubKey: csmKey.key,
          // TODO: bigint?
          withdrawableEpoch: valWithdrawableEpochs[i],
        };
      }
    }
  };
}
