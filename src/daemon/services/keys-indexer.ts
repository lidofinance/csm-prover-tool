import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnApplicationBootstrap } from '@nestjs/common';

import { ConfigService } from '../../common/config/config.service';
import { KeyInfo } from '../../common/handlers/handlers.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import {
  BlockHeaderResponse,
  RootHex,
  Slot,
  StateValidatorResponse,
} from '../../common/providers/consensus/response.interface';
import { Keysapi } from '../../common/providers/keysapi/keysapi';

type Info = {
  moduleAddress: string;
  moduleId: number;
  storageStateSlot: number;
  lastValidatorsCount: number;
};

type Storage = {
  [valIndex: number]: KeyInfo;
};

@Injectable()
export class KeysIndexer implements OnApplicationBootstrap {
  private startedAt: number = 0;

  private info: Low<Info>;
  private storage: Low<Storage>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly keysapi: Keysapi,
  ) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.initOrReadServiceData();
  }

  public getKey = (valIndex: number): KeyInfo | undefined => {
    return this.storage.data[valIndex];
  };

  public async run(finalizedHeader: BlockHeaderResponse): Promise<unknown> {
    // At one time only one task should be running
    if (this.startedAt > 0) {
      this.logger.warn(`🔑 Keys indexer has been running for ${Date.now() - this.startedAt}ms`);
      return;
    }
    const slot = Number(finalizedHeader.header.message.slot);
    if (this.isNotTimeToRun(slot)) {
      this.logger.log('No need to run keys indexer');
      return;
    }
    this.logger.log(`🔑 Keys indexer is running`);
    const stateRoot = finalizedHeader.header.message.state_root;
    if (this.info.data.storageStateSlot == 0) {
      await this.baseRun(stateRoot, slot);
      return;
    }
    // We shouldn't wait for task to finish
    // to avoid block processing if indexing fails or stuck
    this.startedAt = Date.now();
    this.baseRun(stateRoot, slot)
      .catch((e) => this.logger.error(e))
      .finally(() => (this.startedAt = 0));
  }

  private async baseRun(stateRoot: RootHex, finalizedSlot: Slot): Promise<void> {
    this.logger.log(`Get validators. State root [${stateRoot}]`);
    const validators = await this.consensus.getValidators(stateRoot);
    this.logger.log(`Total validators count: ${validators.length}`);
    // TODO: do we need to store already full withdrawn keys ?
    this.info.data.lastValidatorsCount == 0
      ? await this.initStorage(validators, finalizedSlot)
      : await this.updateStorage(validators, finalizedSlot);
    this.logger.log(`CSM validators count: ${Object.keys(this.storage.data).length}`);
    this.info.data.storageStateSlot = finalizedSlot;
    this.info.data.lastValidatorsCount = validators.length;
    await this.info.write();
  }

  private async initStorage(validators: StateValidatorResponse[], finalizedSlot: Slot): Promise<void> {
    this.logger.log(`Init keys data`);
    const csmKeys = await this.keysapi.getModuleKeys(this.info.data.moduleId);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    const keysMap = new Map<string, { operatorIndex: number; index: number }>();
    csmKeys.data.keys.forEach((k: any) => keysMap.set(k.key, { ...k }));
    for (const v of validators) {
      const keyInfo = keysMap.get(v.validator.pubkey);
      if (!keyInfo) continue;
      this.storage.data[Number(v.index)] = {
        operatorId: keyInfo.operatorIndex,
        keyIndex: keyInfo.index,
        pubKey: v.validator.pubkey,
        // TODO: bigint?
        withdrawableEpoch: Number(v.validator.withdrawable_epoch),
      };
    }
    await this.storage.write();
  }

  private async updateStorage(vals: StateValidatorResponse[], finalizedSlot: Slot): Promise<void> {
    // TODO: should we think about re-using validator indexes?
    // TODO: should we think about changing WC for existing old vaidators ?
    if (vals.length - this.info.data.lastValidatorsCount == 0) {
      this.logger.log(`No new validators in the state`);
      return;
    }
    vals = vals.slice(this.info.data.lastValidatorsCount);
    const valKeys = vals.map((v: StateValidatorResponse) => v.validator.pubkey);
    this.logger.log(`New appeared validators count: ${vals.length}`);
    const csmKeys = await this.keysapi.findModuleKeys(this.info.data.moduleId, valKeys);
    this.keysapi.healthCheck(this.consensus.slotToTimestamp(finalizedSlot), csmKeys.meta);
    this.logger.log(`New appeared CSM validators count: ${csmKeys.data.keys.length}`);
    for (const csmKey of csmKeys.data.keys) {
      for (const newVal of vals) {
        if (newVal.validator.pubkey != csmKey.key) continue;
        this.storage.data[Number(newVal.index)] = {
          operatorId: csmKey.operatorIndex,
          keyIndex: csmKey.index,
          pubKey: csmKey.key,
          // TODO: bigint?
          withdrawableEpoch: Number(newVal.validator.withdrawable_epoch),
        };
      }
    }
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
      const modules = (await this.keysapi.getModules()).data;
      const module = modules.find(
        (m: any) => m.stakingModuleAddress.toLowerCase() === this.info.data.moduleAddress.toLowerCase(),
      );
      if (!module) {
        throw new Error(`Module with address ${this.info.data.moduleAddress} not found`);
      }
      this.info.data.moduleId = module.id;
      await this.info.write();
    }
  }
}