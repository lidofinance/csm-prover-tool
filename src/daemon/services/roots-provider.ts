import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { type RootSlot, RootsStack } from './roots-stack.js';
import { ConfigService } from '../../common/config/config.service.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../common/providers/consensus/response.interface.js';

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly rootsStack: RootsStack,
  ) {}

  public async getNext(finalizedHeader: BlockHeaderResponse): Promise<RootHex | undefined> {
    const stacked = this.getStacked();
    if (stacked) return stacked;
    const lastProcessed = this.rootsStack.getLastProcessed();
    if (!lastProcessed) return this.getKnown(finalizedHeader);
    const child = await this.getChild(lastProcessed, finalizedHeader);
    if (child) return child;
    return undefined;
  }

  private getStacked(): RootHex | undefined {
    const stacked = this.rootsStack.getNextEligible();
    if (!stacked) return;
    this.logger.warn(`⏭️ Next root to process [${stacked.blockRoot}]. Taken from 📚 stack of unprocessed roots`);
    return stacked.blockRoot;
  }

  private getKnown(finalizedHeader: BlockHeaderResponse): RootHex | undefined {
    const configured = this.config.get('START_ROOT');
    if (configured) {
      this.logger.log(`No processed roots. Start from ⚙️ configured root [${configured}]`);
      return configured;
    }
    this.logger.log(`No processed roots. Start from 💎 last finalized root [${finalizedHeader.root}]`);
    return finalizedHeader.root;
  }

  private async getChild(lastProcessed: RootSlot, finalizedHeader: BlockHeaderResponse): Promise<RootHex | undefined> {
    this.logger.log(`⏮️ Last processed slot [${lastProcessed.slotNumber}]. Root [${lastProcessed.blockRoot}]`);
    if (lastProcessed.blockRoot == finalizedHeader.root) return;
    const diff = Number(finalizedHeader.header.message.slot) - lastProcessed.slotNumber;
    this.logger.warn(`Diff between last processed and finalized is ${diff} slots`);
    const childHeaders = await this.consensus.getBeaconHeadersByParentRoot(lastProcessed.blockRoot);
    if (childHeaders.data.length == 0 || !childHeaders.finalized) {
      // NOTE: such responses are not cached (see `childHeadersCache` config in
      // `Consensus`), so the next call will refetch from the CL and pick up
      // the child once it gets finalized.
      this.logger.warn(`No finalized child header for [${lastProcessed.blockRoot}] yet`);
      return;
    }
    const child = childHeaders.data[0].root;
    this.logger.log(`⏭️ Next root to process [${child}]. Child of last processed`);
    return child;
  }
}
