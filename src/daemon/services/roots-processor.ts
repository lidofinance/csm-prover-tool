import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootSlot, RootsStack } from './roots-stack';
import { PrometheusService } from '../../common/prometheus';
import { ProverService } from '../../common/prover/prover.service';
import { Consensus } from '../../common/providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../common/providers/consensus/response.interface';

@Injectable()
export class RootsProcessor {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsStack: RootsStack,
    protected readonly prover: ProverService,
  ) {}

  public async processNext(blockRootToProcess: RootHex, finalizedHeader: BlockHeaderResponse): Promise<void> {
    this.logger.log(`🛃 Root in processing [${blockRootToProcess}]`);
    const blockInfoToProcess = await this.consensus.getBlockInfo(blockRootToProcess);
    const rootSlot: RootSlot = {
      blockRoot: blockRootToProcess,
      slotNumber: blockInfoToProcess.slot,
    };
    await this.rootsStack.push(rootSlot); // in case of revert we should reprocess the root
    await this.prover.handleWithdrawalsInBlock(
      blockRootToProcess,
      blockInfoToProcess,
      finalizedHeader,
      this.keysIndexer.getKey,
    );
    const indexerIsTrusted = this.keysIndexer.isTrustedForEveryDuty(rootSlot.slotNumber);
    if (indexerIsTrusted) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }
}
