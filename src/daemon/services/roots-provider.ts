import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { type RootSlot, RootsStack } from './roots-stack.js';
import { ConfigService } from '../../common/config/config.service.js';
import { toRootHex } from '../../common/helpers/proofs.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import { type BlockHeaderResponse } from '../../common/providers/consensus/response.interface.js';

@Injectable()
export class RootsProvider {
  // A confirmed child held back by the lag gate, so idle cycles don't re-walk empty slots
  private confirmedChild?: { parentRoot: RootHex; child: RootSlot };

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly rootsStack: RootsStack,
  ) {}

  public async getNext(finalizedHeader: BlockHeaderResponse): Promise<RootHex | undefined> {
    const lastProcessed = this.rootsStack.getLastProcessed();
    if (!lastProcessed) {
      // Cold start: skip possible further lag gate (candidate = finalizedHeader.root).
      return this.getKnown(finalizedHeader);
    }

    const lag = this.config.get('ROOTS_PROCESSING_LAG_SLOTS');
    const stacked = this.rootsStack.getNextEligible();
    let candidate: RootSlot | undefined;
    if (stacked) {
      this.logger.warn(`Next root to process [${stacked.blockRoot}]. Taken from 📚 stack of unprocessed roots`);
      candidate = stacked;
    } else {
      // No child can pass the lag gate yet, so don't probe the node
      if (lag > 0 && lag > Number(finalizedHeader.header.message.slot) - (lastProcessed.slotNumber + 1))
        return undefined;
      candidate = await this.getChild(lastProcessed, finalizedHeader);
    }
    if (!candidate) return undefined;

    const diff = Number(finalizedHeader.header.message.slot) - candidate.slotNumber;
    if (lag > 0 && lag > diff) {
      this.logger.log(`💤 Next root to process ${diff} slots behind finalized, need ${lag}`);
      return undefined;
    }
    return candidate.blockRoot;
  }

  private getKnown(finalizedHeader: BlockHeaderResponse): RootHex {
    const configured = this.config.get('START_ROOT');
    if (configured) {
      this.logger.log(`No processed roots. Start from ⚙️ configured root [${configured}]`);
      return configured;
    }
    this.logger.log(`No processed roots. Start from 💎 last finalized root [${finalizedHeader.root}]`);
    return finalizedHeader.root;
  }

  private async getChild(lastProcessed: RootSlot, finalizedHeader: BlockHeaderResponse): Promise<RootSlot | undefined> {
    this.logger.log(`⏮️ Last processed slot [${lastProcessed.slotNumber}]. Root [${lastProcessed.blockRoot}]`);
    if (lastProcessed.blockRoot == finalizedHeader.root) return;
    const diff = Number(finalizedHeader.header.message.slot) - lastProcessed.slotNumber;
    this.logger.warn(`Diff between last processed and finalized is ${diff} slots`);
    const finalizedSlot = Number(finalizedHeader.header.message.slot);
    if (this.confirmedChild?.parentRoot === lastProcessed.blockRoot) return this.confirmedChild.child;
    for (let slot = lastProcessed.slotNumber + 1; slot <= finalizedSlot; slot++) {
      const header = await this.consensus.findBeaconHeader(slot);
      if (!header) continue;
      // Both flags come from one response, so a load balancer can't mix two nodes' views.
      if (!header.canonical || !header.finalized) {
        this.logger.log(
          `💤 Next block [${header.root}] not confirmed canonical and finalized yet. Retrying next cycle`,
        );
        return;
      }
      if (toRootHex(header.header.message.parentRoot) === lastProcessed.blockRoot) {
        this.logger.log(`⏭️ Next root to process [${header.root}]. Child of last processed`);
        const child = { blockRoot: header.root, slotNumber: slot };
        this.confirmedChild = { parentRoot: lastProcessed.blockRoot, child };
        return child;
      }
      return await this.rewindIfOrphaned(lastProcessed);
    }
    return;
  }

  private async rewindIfOrphaned(lastProcessed: RootSlot): Promise<undefined> {
    const header = await this.consensus.findBeaconHeader(lastProcessed.blockRoot);
    if (header?.canonical && header.finalized) {
      this.logger.warn(
        `⚠️ Gap between finalized last processed [${lastProcessed.blockRoot}] and next finalized block: a block in between has not been processed yet. Rechecking next cycle`,
      );
      return;
    }
    const rewindSlots = this.consensus.epochToSlot(this.config.get('ROOTS_ORPHAN_REWIND_EPOCHS'));
    for (let slot = lastProcessed.slotNumber - rewindSlots; slot >= 0; slot--) {
      const target = await this.consensus.findBeaconHeader(slot);
      if (!target) continue;
      // Rewind only to a block confirmed canonical and finalized by one response.
      if (!target.canonical || !target.finalized) {
        this.logger.log(
          `💤 Rewind target [${target.root}] at slot ${slot} not confirmed canonical and finalized yet. Retrying next cycle`,
        );
        return;
      }
      await this.rootsStack.rewind({ blockRoot: target.root, slotNumber: slot });
      this.logger.error(
        `⚠️ Last processed [${lastProcessed.blockRoot}] at slot ${lastProcessed.slotNumber} is not confirmed on the finalized chain. Rewound to [${target.root}] at slot ${slot}`,
      );
      return;
    }
  }
}
