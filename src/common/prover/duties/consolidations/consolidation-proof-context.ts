import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { Consensus } from '../../../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../../providers/consensus/response.interface';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../../utils/historical-summary';
import { ConsolidationProofContext } from './consolidations.types';

@Injectable()
export class ConsolidationProofContextResolver {
  constructor(
    @Inject(LOGGER_PROVIDER) private readonly logger: LoggerService,
    private readonly consensus: Consensus,
  ) {}

  public async resolve(
    consolidationBlockRoot: RootHex,
    finalizedHeader: BlockHeaderResponse,
  ): Promise<ConsolidationProofContext | null> {
    const consolidationHeader = await this.consensus.getBeaconHeader(consolidationBlockRoot);
    const consolidationSlot = Number(consolidationHeader.header.message.slot);
    const summaryResolution = await resolveHistoricalSummaryContext(this.consensus, finalizedHeader, consolidationSlot);
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.BeforeCapella) {
      this.logger.warn(`Consolidation block ${consolidationBlockRoot} is before Capella fork slot`);
      return null;
    }
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.NotHistoricalYet) {
      this.logger.log(
        `Consolidation block ${consolidationBlockRoot} is not historical yet (summary slot ${summaryResolution.summarySlot})`,
      );
      return null;
    }
    const { summaryState, summaryIndex, rootIndexInSummary } = summaryResolution.context;
    const consolidationState = await this.consensus.getState(consolidationHeader.header.message.state_root);
    return {
      consolidationHeader,
      consolidationState,
      summaryState,
      summaryIndex,
      rootIndexInSummary,
    };
  }
}
