import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { Injectable, OnModuleInit } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootHex } from '../../common/providers/consensus/response.interface';

export type RootSlot = { blockRoot: RootHex; slotNumber: number };

type RootsStackServiceInfo = {
  lastProcessedRootSlot: RootSlot | undefined;
};

type RootsStackServiceStorage = { [slot: number]: RootHex };

@Injectable()
export class RootsStack implements OnModuleInit {
  private info: Low<RootsStackServiceInfo>;
  private storage: Low<RootsStackServiceStorage>;

  constructor(protected readonly keysIndexer: KeysIndexer) {}

  async onModuleInit(): Promise<void> {
    await this.initOrReadServiceData();
  }

  public getNextEligible(): RootSlot | undefined {
    for (const slot in this.storage.data) {
      if (this.keysIndexer.isTrustedForAnyDuty(Number(slot))) {
        return { blockRoot: this.storage.data[slot], slotNumber: Number(slot) };
      }
    }
  }

  public async push(rs: RootSlot): Promise<void> {
    if (this.storage.data[rs.slotNumber] !== undefined) return;
    this.storage.data[rs.slotNumber] = rs.blockRoot;
    await this.storage.write();
  }

  public async purge(rs: RootSlot): Promise<void> {
    if (this.storage.data[rs.slotNumber] == undefined) return;
    delete this.storage.data[rs.slotNumber];
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
    this.info = new Low<RootsStackServiceInfo>(new JSONFile('.roots-stack-info.json'), {
      lastProcessedRootSlot: undefined,
    });
    this.storage = new Low<RootsStackServiceStorage>(new JSONFile('.roots-stack-storage.json'), {});
    await this.info.read();
    await this.storage.read();
  }
}
