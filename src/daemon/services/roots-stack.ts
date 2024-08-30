import { Low } from '@huanshiwushuang/lowdb';
import { JSONFile } from '@huanshiwushuang/lowdb/node';
import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import {
  METRIC_DATA_ACTUALITY,
  METRIC_LAST_PROCESSED_SLOT_NUMBER,
  METRIC_ROOTS_STACK_OLDEST_SLOT,
  METRIC_ROOTS_STACK_SIZE,
  PrometheusService,
} from '../../common/prometheus';
import { Consensus } from '../../common/providers/consensus/consensus';
import { RootHex } from '../../common/providers/consensus/response.interface';

export type RootSlot = { blockRoot: RootHex; slotNumber: number };

type RootsStackServiceInfo = {
  lastProcessedRootSlot: RootSlot | undefined;
};

type RootsStackServiceStorage = { [slot: number]: RootHex };

@Injectable()
export class RootsStack implements OnModuleInit, OnApplicationBootstrap {
  private info: Low<RootsStackServiceInfo>;
  private storage: Low<RootsStackServiceStorage>;

  constructor(
    protected readonly prometheus: PrometheusService,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly consensus: Consensus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initOrReadServiceData();
  }

  async onApplicationBootstrap(): Promise<void> {
    this.setMetrics();
  }

  public getNextEligible(): RootSlot | undefined {
    for (const slot of Object.keys(this.storage.data).map(Number).sort()) {
      if (this.keysIndexer.isTrustedForAnyDuty(slot)) {
        return { blockRoot: this.storage.data[slot], slotNumber: slot };
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
    this.info = new Low<RootsStackServiceInfo>(new JSONFile('storage/roots-stack-info.json'), {
      lastProcessedRootSlot: undefined,
    });
    this.storage = new Low<RootsStackServiceStorage>(new JSONFile('storage/roots-stack-storage.json'), {});
    await this.info.read();
    await this.storage.read();
  }

  private setMetrics() {
    const lastProcessed = () => Number(this.info.data.lastProcessedRootSlot?.slotNumber);
    const getSlotTimeDiffWithNow = () => Date.now() - this.consensus.slotToTimestamp(lastProcessed()) * 1000;
    const rootsStackSize = () => Object.keys(this.storage.data).length;
    const rootsStackOldestSlot = () => Math.min(...Object.keys(this.storage.data).map(Number));
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_DATA_ACTUALITY,
      help: 'Data actuality',
      labelNames: [],
      collect() {
        this.set(getSlotTimeDiffWithNow());
      },
    });
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_LAST_PROCESSED_SLOT_NUMBER,
      help: 'Last processed slot',
      labelNames: [],
      collect() {
        this.set(lastProcessed());
      },
    });
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_ROOTS_STACK_SIZE,
      help: 'Roots stack size',
      labelNames: [],
      collect() {
        this.set(rootsStackSize());
      },
    });
    this.prometheus.getOrCreateMetric('Gauge', {
      name: METRIC_ROOTS_STACK_OLDEST_SLOT,
      help: 'Roots stack oldest slot',
      labelNames: [],
      collect() {
        this.set(rootsStackOldestSlot());
      },
    });
  }
}
