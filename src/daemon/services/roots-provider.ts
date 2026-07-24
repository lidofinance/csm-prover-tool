import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { type RootSlot, RootsStack } from './roots-stack.js';
import { ConfigService } from '../../common/config/config.service.js';
import { toRootHex } from '../../common/helpers/proofs.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import { type BlockHeaderResponse, firstCanonical } from '../../common/providers/consensus/response.interface.js';
import { Execution } from '../../common/providers/execution/execution.js';

@Injectable()
export class RootsProvider {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly execution: Execution,
    protected readonly rootsStack: RootsStack,
  ) {}

  public async getNext(finalizedHeader: BlockHeaderResponse): Promise<RootHex | undefined> {
    const lastProcessed = this.rootsStack.getLastProcessed();
    const { root: horizonRoot } = await this.execution.getFinalizedBeaconAnchor();
    const horizonSlot = Number((await this.consensus.getBeaconHeader(horizonRoot)).header.message.slot);

    if (!lastProcessed) {
      return await this.getKnown(horizonRoot);
    }

    const stacked = this.rootsStack.getNextEligible();
    let candidate: RootSlot | undefined;
    if (stacked) {
      this.logger.warn(`Next root to process [${stacked.blockRoot}]. Taken from 📚 stack of unprocessed roots`);
      candidate = stacked;
    } else {
      candidate = await this.getChild(lastProcessed, finalizedHeader);
    }
    if (!candidate) return undefined;

    if (candidate.slotNumber >= horizonSlot) {
      this.logger.log(`⏳ Root slot ${candidate.slotNumber} is not provable yet; EL horizon is ${horizonSlot}`);
      return;
    }
    const lag = this.config.get('ROOTS_PROCESSING_LAG_SLOTS');
    const diff = Number(finalizedHeader.header.message.slot) - candidate.slotNumber;
    if (lag > 0 && lag > diff) {
      this.logger.log(`💤 Next root to process ${diff} slots behind finalized, need ${lag}`);
      return;
    }
    return candidate.blockRoot;
  }

  private async getKnown(horizonRoot: RootHex): Promise<RootHex> {
    const configured = this.config.get('START_ROOT');
    if (configured) {
      this.logger.log(`No processed roots. Start from ⚙️ configured root [${configured}]`);
      return configured;
    }
    const parentRoot = toRootHex((await this.consensus.getBlockInfo(horizonRoot)).parentRoot);
    this.logger.log(`No processed roots. Start from 🔐 parent of EL proof horizon [${parentRoot}]`);
    return parentRoot;
  }

  private async getChild(lastProcessed: RootSlot, finalizedHeader: BlockHeaderResponse): Promise<RootSlot | undefined> {
    this.logger.log(`⏮️ Last processed slot [${lastProcessed.slotNumber}]. Root [${lastProcessed.blockRoot}]`);
    if (lastProcessed.blockRoot == finalizedHeader.root) return;
    const diff = Number(finalizedHeader.header.message.slot) - lastProcessed.slotNumber;
    this.logger.warn(`Diff between last processed and finalized is ${diff} slots`);
    const childHeaders = await this.consensus.getBeaconHeadersByParentRoot(lastProcessed.blockRoot);
    if (childHeaders.data.length == 0 || !childHeaders.finalized) {
      this.logger.warn(`No finalized child header for [${lastProcessed.blockRoot}] yet`);
      return;
    }
    const canonical = firstCanonical(childHeaders.data);
    if (!canonical) {
      this.logger.warn(
        `Got ${childHeaders.data.length} child header(s) for [${lastProcessed.blockRoot}] but none canonical.`,
      );
      return;
    }
    this.logger.log(`⏭️ Next root to process [${canonical.root}]. Child of last processed`);
    return {
      blockRoot: canonical.root,
      slotNumber: Number(canonical.header.message.slot),
    };
  }
}
