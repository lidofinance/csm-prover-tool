import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootsStack } from './roots-stack';
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

  public async process(blockRoot: RootHex): Promise<any> {
    this.logger.log(`🛃 Root in processing [${blockRoot}]`);
    const blockInfo = await this.consensus.getBlockInfo(blockRoot);
    const rootSlot = {
      blockRoot,
      slotNumber: Number(blockInfo.message.slot),
    };
    const indexerIsOK = this.keysIndexer.eligibleForEveryDuty(rootSlot.slotNumber);
    if (!indexerIsOK) await this.rootsStack.push(rootSlot); // only new will be pushed
    await this.handlers.proveIfNeeded(blockRoot, blockInfo, this.keysIndexer.getKey);
    if (indexerIsOK) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }
}
