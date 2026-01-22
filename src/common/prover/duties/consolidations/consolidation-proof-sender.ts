import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { ConsolidationProofContextResolver } from './consolidation-proof-context';
import { ConsolidationToProve } from './consolidations.types';
import { VerifierContract } from '../../../contracts/verifier-contract.service';
import { Consensus } from '../../../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../../providers/consensus/response.interface';
import { WorkersService } from '../../../workers/workers.service';

@Injectable()
export class ConsolidationProofSender {
  constructor(
    @Inject(LOGGER_PROVIDER) private readonly logger: LoggerService,
    private readonly workers: WorkersService,
    private readonly consensus: Consensus,
    private readonly verifier: VerifierContract,
    private readonly contextResolver: ConsolidationProofContextResolver,
  ) {}

  public async send(finalizedHeader: BlockHeaderResponse, consolidations: ConsolidationToProve[]): Promise<number> {
    if (!consolidations.length) return 0;
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    if (!nextHeader) throw new Error(`Next block header after ${finalizedHeader.root} not found`);
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));

    const grouped = this.groupByRoot(consolidations);

    let sentCount = 0;
    for (const [consolidationBlockRoot, items] of grouped.entries()) {
      const context = await this.contextResolver.resolve(consolidationBlockRoot, finalizedHeader);
      if (!context) continue;
      this.logger.log('Building consolidation proof payloads');
      const payloads = await this.workers.getConsolidationProofPayloads({
        recentHeader: finalizedHeader,
        nextHeaderTimestamp: nextHeaderTs,
        recentState: finalizedState,
        consolidationHeader: context.consolidationHeader,
        consolidationState: context.consolidationState,
        summaryState: context.summaryState,
        summaryIndex: context.summaryIndex,
        rootIndexInSummary: context.rootIndexInSummary,
        consolidations: items,
      });
      for (const payload of payloads) {
        this.logger.log(`📡 Sending consolidation proof payload for validator index: ${payload.validator.index}`);
        await this.verifier.sendConsolidationProof(payload);
        sentCount++;
      }
    }
    return sentCount;
  }

  private groupByRoot(consolidations: ConsolidationToProve[]): Map<RootHex, ConsolidationToProve[]> {
    const grouped = new Map<RootHex, ConsolidationToProve[]>();
    for (const consolidation of consolidations) {
      const existing = grouped.get(consolidation.consolidationBlockRoot);
      if (existing) {
        existing.push(consolidation);
      } else {
        grouped.set(consolidation.consolidationBlockRoot, [consolidation]);
      }
    }
    this.logger.log(
      `Grouped consolidations by root: ${grouped.size} groups. Roots: [${[...grouped.keys()].join(', ')}]`,
    );
    return grouped;
  }
}
