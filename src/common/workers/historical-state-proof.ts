import type { SingleProof } from '@chainsafe/persistent-merkle-tree';

import { WorkerLogger } from './worker-logger.js';
import { generateHistoricalStateProof, verifyProof } from '../helpers/proofs.js';
import type { State } from '../providers/consensus/consensus.js';
import { type SupportedBlockRootsView, getSsz } from '../providers/consensus/forks.js';

// The full state view lives only in this frame so it can be collected before the target state is deserialized.
export async function buildHistoricalStateProof(
  finalizedState: State,
  summaryBlockRoots: SupportedBlockRootsView,
  summaryIndex: number,
  rootIndexInSummary: number,
): Promise<SingleProof> {
  const finalizedStateView = getSsz(finalizedState.forkName).BeaconState.deserializeToView(finalizedState.bodyBytes);
  WorkerLogger.log('Generating historical state proof');
  const historicalStateProof = await generateHistoricalStateProof(
    finalizedStateView,
    summaryBlockRoots,
    summaryIndex,
    rootIndexInSummary,
  );
  WorkerLogger.log('Verifying historical state proof locally');
  verifyProof(
    finalizedStateView.hashTreeRoot(),
    historicalStateProof.gindex,
    historicalStateProof.witnesses,
    summaryBlockRoots.getReadonly(rootIndexInSummary),
  );
  return historicalStateProof;
}
