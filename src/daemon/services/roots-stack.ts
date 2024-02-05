import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootHex } from '../../common/providers/consensus/response.interface';

export type RootSlot = { blockRoot: string; slotNumber: number };

type Info = {
  lastProcessedRootSlot: RootSlot | undefined;
};

type Storage = RootSlot[];

@Injectable()
export class RootsStack implements OnApplicationBootstrap {
  private info: Low<Info>;
  private storage: Low<Storage>;

  constructor(protected readonly keysIndexer: KeysIndexer) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.initOrReadServiceData();
  }

  public getNextEligible(): RootSlot | undefined {
    return this.storage.data.find((s) => this.keysIndexer.eligibleForAnyDuty(s.slotNumber));
  }

  public async push(rs: RootSlot): Promise<void> {
    const idx = this.storage.data.findIndex((i) => rs.blockRoot == i.blockRoot);
    if (idx !== -1) return;
    this.storage.data.push(rs);
    await this.storage.write();
  }

  public async purge(blockRoot: RootHex): Promise<void> {
    const idx = this.storage.data.findIndex((i) => blockRoot == i.blockRoot);
    if (idx == -1) return;
    this.storage.data.splice(idx, 1);
    await this.storage.write();
  }

  public getLastProcessed(): RootSlot | undefined {
    return this.info.data.lastProcessedRootSlot;
  }

  public async setLastProcessed(item: RootSlot): Promise<void> {
    this.info.data.lastProcessedRootSlot = item;
    await this.info.write();
  }

  private async initOrReadServiceData() {
    this.info = new Low<Info>(new JSONFile('.roots-stack-info.json'), {
      lastProcessedRootSlot: undefined,
    });
    this.storage = new Low<Storage>(new JSONFile('.roots-stack-storage.json'), []);
    await this.info.read();
    await this.storage.read();
  }
}
