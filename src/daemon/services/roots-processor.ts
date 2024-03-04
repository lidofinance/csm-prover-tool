import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootSlot, RootsStack } from './roots-stack';
import { HandlersService } from '../../common/handlers/handlers.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { RootHex } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsStack: RootsStack,
    protected readonly handlers: HandlersService,
  ) {}

  public async process(blockRoot: RootHex): Promise<void> {
    this.logger.log(`🛃 Root in processing [${blockRoot}]`);
    const blockInfo = await this.consensus.getBlockInfo(blockRoot);
    const rootSlot: RootSlot = {
      blockRoot,
      slotNumber: Number(blockInfo.message.slot),
    };
    const indexerIsTrusted = this.keysIndexer.isTrustedForEveryDuty(rootSlot.slotNumber);
    if (!indexerIsTrusted) await this.rootsStack.push(rootSlot); // only new will be pushed
    await this.handlers.proveIfNeeded(blockRoot, blockInfo, this.keysIndexer.getKey);
    if (indexerIsTrusted) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }
}
