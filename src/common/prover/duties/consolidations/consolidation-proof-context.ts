import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import type { ConsolidationProofContext } from './consolidations.types.js';
import { toRootHex } from '../../../helpers/proofs.js';
import { type AppLogger } from '../../../logger/app-logger.type.js';
import { Consensus } from '../../../providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../../providers/consensus/response.interface.js';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../../utils/historical-summary.js';

@Injectable()
export class ConsolidationProofContextResolver {
  constructor(
    @Inject(LOGGER_PROVIDER) private readonly logger: AppLogger,
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
    const consolidationState = await this.consensus.getState(toRootHex(consolidationHeader.header.message.stateRoot));
    return {
      consolidationHeader,
      consolidationState,
      summaryState,
      summaryIndex,
      rootIndexInSummary,
    };
  }
}
