import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootSlot, RootsStack } from './roots-stack';
import { ProverService } from '../../common/prover/prover.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { RootHex } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsStack: RootsStack,
    protected readonly prover: ProverService,
  ) {}

  public async process(blockRootToProcess: RootHex, finalizedRoot: RootHex): Promise<void> {
    this.logger.log(`🛃 Root in processing [${blockRootToProcess}]`);
    const blockInfoToProcess = await this.consensus.getBlockInfo(blockRootToProcess);
    const rootSlot: RootSlot = {
      blockRoot: blockRootToProcess,
      slotNumber: Number(blockInfoToProcess.message.slot),
    };
    const indexerIsTrusted = this.keysIndexer.isTrustedForEveryDuty(rootSlot.slotNumber);
    if (!indexerIsTrusted) await this.rootsStack.push(rootSlot); // only new will be pushed
    // prove slashings or withdrawals if needed
    await this.prover.handleBlock(blockRootToProcess, blockInfoToProcess, finalizedRoot, this.keysIndexer.getKey);
    if (indexerIsTrusted) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }
}
