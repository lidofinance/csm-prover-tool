import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { KeysIndexer } from './keys-indexer';
import { RootSlot, RootsStack } from './roots-stack';
import { PrometheusService, TrackTask } from '../../common/prometheus';
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

  @TrackTask('process-root')
  public async process(blockRootToProcess: RootHex, finalizedHeader: BlockHeaderResponse): Promise<void> {
    this.logger.log(`🛃 Root in processing [${blockRootToProcess}]`);
    const blockInfoToProcess = await this.consensus.getBlockInfo(blockRootToProcess);
    const rootSlot: RootSlot = {
      blockRoot: blockRootToProcess,
      slotNumber: blockInfoToProcess.slot,
    };
    await this.rootsStack.push(rootSlot); // in case of revert we should reprocess the root
    await this.prover.handleBlock(
      blockRootToProcess,
      blockInfoToProcess,
      finalizedHeader,
      this.keysIndexer.getKey,
      this.keysIndexer.getFullKeyInfoByPubKey,
    );
    const indexerIsTrusted = this.keysIndexer.isTrustedForEveryDuty(rootSlot.slotNumber);
    if (indexerIsTrusted) await this.rootsStack.purge(rootSlot);
    await this.rootsStack.setLastProcessed(rootSlot);
  }
}
