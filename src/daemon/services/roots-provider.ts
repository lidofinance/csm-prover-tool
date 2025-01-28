import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { RootSlot, RootsStack } from './roots-stack';
import { ConfigService } from '../../common/config/config.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly rootsStack: RootsStack,
  ) {}

  public async getNext(finalizedHeader: BlockHeaderResponse): Promise<RootHex | undefined> {
    const stacked = this.getStacked();
    if (stacked) return stacked;
    const lastProcessed = this.rootsStack.getLastProcessed();
    if (!lastProcessed) return this.getKnown(finalizedHeader);
    return await this.getChild(lastProcessed, finalizedHeader);
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
      this.logger.warn(`No finalized child header for [${lastProcessed.blockRoot}] yet`);
      return;
    }
    const child = childHeaders.data[0].root;
    this.logger.log(`⏭️ Next root to process [${child}]. Child of last processed`);
    return child;
  }
}
