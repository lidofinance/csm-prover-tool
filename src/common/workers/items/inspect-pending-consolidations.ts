import { parentPort, workerData } from 'node:worker_threads';

import type { State } from '../../providers/consensus/consensus.js';
import { getSsz, isPostElectraFork } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type PendingConsolidationInfo = {
  sourceIndex: number;
  targetIndex: number;
  withdrawableEpoch: number;
  slashed: boolean;
};

export type InspectPendingConsolidationsArgs = {
  state: State;
};

export type InspectPendingConsolidationsResult = PendingConsolidationInfo[];

async function inspectPendingConsolidations(): Promise<InspectPendingConsolidationsResult> {
  const { state } = workerData as InspectPendingConsolidationsArgs;
  if (!isPostElectraFork(state.forkName)) {
    WorkerLogger.warn('Pending consolidations are not available in this fork');
    return [];
  }
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);
  const pendingConsolidationsView = stateView.pendingConsolidations;

  const allPending: PendingConsolidationInfo[] = [];
  for (let i = 0; i < pendingConsolidationsView.length; i++) {
    const entry = pendingConsolidationsView.getReadonly(i);
    const sourceIndex = Number(entry.sourceIndex);
    const targetIndex = Number(entry.targetIndex);
    const sourceValidator = stateView.validators.getReadonly(sourceIndex);
    allPending.push({
      sourceIndex,
      targetIndex,
      withdrawableEpoch: Number(sourceValidator.withdrawableEpoch),
      slashed: Boolean(sourceValidator.slashed),
    });
  }

  return allPending;
}

inspectPendingConsolidations()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
