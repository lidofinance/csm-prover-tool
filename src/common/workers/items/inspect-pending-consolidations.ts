import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import { State } from '../../providers/consensus/consensus';
import { WorkerLogger } from '../workers.service';

let ssz: typeof sszType;

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
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { state } = workerData as InspectPendingConsolidationsArgs;
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  // @ts-expect-error: pending consolidations exist only after Electra.
  const pendingConsolidationsView = stateView.pendingConsolidations;
  if (!pendingConsolidationsView) {
    WorkerLogger.warn('Pending consolidations are not available in this fork');
    return [];
  }

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
    console.error(e);
    throw e;
  });
