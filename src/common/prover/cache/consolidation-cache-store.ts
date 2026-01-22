import { Injectable } from '@nestjs/common';
import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';

import { RootHex } from '../../providers/consensus/response.interface';

type ConsolidationCacheEntry = {
  sourceIndex: number;
  targetIndex: number;
  withdrawableEpoch: number;
  // Captures the block root whose state precedes the epoch transition that processed the consolidation.
  // Needed to build proofs later, even if we can't send them in the same epoch.
  consolidationBlockRoot?: RootHex;
};

export type ConsolidationKey = string;

type ConsolidationCacheStorage = { [key: string]: ConsolidationCacheEntry };

export interface ConsolidationCacheStore {
  ensureReady(): Promise<void>;
  makeKey(sourceIndex: number, targetIndex: number): ConsolidationKey;
  entries(): IterableIterator<[ConsolidationKey, ConsolidationCacheEntry]>;
  get(key: ConsolidationKey): ConsolidationCacheEntry | undefined;
  set(key: ConsolidationKey, entry: ConsolidationCacheEntry): void;
  delete(key: ConsolidationKey): boolean;
  flushIfPendingWrite(): Promise<void>;
}

export class NoopConsolidationCacheStore implements ConsolidationCacheStore {
  public async ensureReady(): Promise<void> {}

  public makeKey(sourceIndex: number, targetIndex: number): ConsolidationKey {
    return `${sourceIndex}:${targetIndex}`;
  }

  public entries(): IterableIterator<[ConsolidationKey, ConsolidationCacheEntry]> {
    return new Map<ConsolidationKey, ConsolidationCacheEntry>().entries();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public get(_key: ConsolidationKey): ConsolidationCacheEntry | undefined {
    // eslint-disable-line @typescript-eslint/no-unused-vars
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public set(_key: ConsolidationKey, _entry: ConsolidationCacheEntry): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public delete(_key: ConsolidationKey): boolean {
    return false;
  }

  public async flushIfPendingWrite(): Promise<void> {}
}

@Injectable()
export class PersistentConsolidationCacheStore implements ConsolidationCacheStore {
  private readonly cache = new Map<ConsolidationKey, ConsolidationCacheEntry>();
  private readonly storagePath = 'storage/roots-stack-consolidations.json';
  private storage: Low<ConsolidationCacheStorage> | null = null;
  private pendingWrite = false;

  public async ensureReady(): Promise<void> {
    if (this.storage) return;
    this.storage = new Low<ConsolidationCacheStorage>(new JSONFile(this.storagePath), {});
    await this.storage.read();
    if (!this.storage.data) {
      this.storage.data = {};
    }
    for (const [key, entry] of Object.entries(this.storage.data)) {
      this.cache.set(key, entry);
    }
  }

  public makeKey(sourceIndex: number, targetIndex: number): ConsolidationKey {
    return `${sourceIndex}:${targetIndex}`;
  }

  public entries(): IterableIterator<[ConsolidationKey, ConsolidationCacheEntry]> {
    return this.cache.entries();
  }

  public get(key: ConsolidationKey): ConsolidationCacheEntry | undefined {
    return this.cache.get(key);
  }

  public set(key: ConsolidationKey, entry: ConsolidationCacheEntry): void {
    this.cache.set(key, entry);
    this.storage!.data[key] = entry;
    this.pendingWrite = true;
  }

  public delete(key: ConsolidationKey): boolean {
    if (!this.cache.delete(key)) return false;
    delete this.storage!.data[key];
    this.pendingWrite = true;
    return true;
  }

  public async flushIfPendingWrite(): Promise<void> {
    if (!this.pendingWrite) return;
    await this.storage!.write();
    this.pendingWrite = false;
  }
}
