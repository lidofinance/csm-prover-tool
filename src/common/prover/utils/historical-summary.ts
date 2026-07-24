import { type Consensus, type State } from '../../providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';

export type HistoricalSummaryInfo = {
  summaryIndex: number;
  summarySlot: number;
  rootIndex: number;
};

export type HistoricalSummaryContext = {
  summaryState: State;
  summaryIndex: number;
  rootIndexInSummary: number;
  summarySlot: number;
};

export enum HistoricalSummaryResolutionStatus {
  Available = 'available',
  BeforeCapella = 'before_capella',
  NotHistoricalYet = 'not_historical_yet',
}

export type HistoricalSummaryResolution =
  | { status: HistoricalSummaryResolutionStatus.Available; context: HistoricalSummaryContext }
  | { status: HistoricalSummaryResolutionStatus.BeforeCapella }
  | { status: HistoricalSummaryResolutionStatus.NotHistoricalYet; summarySlot: number };

export function getHistoricalSummaryInfo(consensus: Consensus, targetSlot: number): HistoricalSummaryInfo | null {
  const capellaForkSlot = consensus.epochToSlot(Number(consensus.beaconConfig.CAPELLA_FORK_EPOCH));
  const slotsPerHistoricalRoot = Number(consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
  if (targetSlot < capellaForkSlot) return null;
  const summaryIndex = Math.floor((targetSlot - capellaForkSlot) / slotsPerHistoricalRoot);
  const rootIndex = targetSlot % slotsPerHistoricalRoot;
  const summarySlot = capellaForkSlot + (summaryIndex + 1) * slotsPerHistoricalRoot;
  return { summaryIndex, summarySlot, rootIndex };
}

export async function resolveHistoricalSummaryContext(
  consensus: Consensus,
  finalizedHeader: BlockHeaderResponse,
  targetSlot: number,
): Promise<HistoricalSummaryResolution> {
  const summaryInfo = getHistoricalSummaryInfo(consensus, targetSlot);
  if (!summaryInfo) return { status: HistoricalSummaryResolutionStatus.BeforeCapella };
  const finalizedSlot = Number(finalizedHeader.header.message.slot);
  if (summaryInfo.summarySlot > finalizedSlot) {
    return { status: HistoricalSummaryResolutionStatus.NotHistoricalYet, summarySlot: summaryInfo.summarySlot };
  }
  const summaryState = await consensus.getState(summaryInfo.summarySlot);
  return {
    status: HistoricalSummaryResolutionStatus.Available,
    context: {
      summaryState,
      summaryIndex: summaryInfo.summaryIndex,
      rootIndexInSummary: summaryInfo.rootIndex,
      summarySlot: summaryInfo.summarySlot,
    },
  };
}
