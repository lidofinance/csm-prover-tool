import { parentPort, workerData } from 'node:worker_threads';

import { toHex } from '../../helpers/proofs.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getSsz } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetNewValidatorKeysArgs = {
  state: State;
  lastValidatorsCount: number;
};

export type GetNewValidatorKeysResult = {
  totalValLength: number;
  valKeys: string[];
};

async function getNewValidatorKeys(): Promise<GetNewValidatorKeysResult> {
  const { state, lastValidatorsCount } = workerData as GetNewValidatorKeysArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const totalValLength = stateView.validators.length;
  const appearedValsCount = totalValLength - lastValidatorsCount;
  if (appearedValsCount === 0) {
    return { totalValLength, valKeys: [] };
  }

  const valKeys: string[] = [];
  for (let i = lastValidatorsCount; i < totalValLength; i++) {
    valKeys.push(toHex(stateView.validators.get(i).pubkey));
  }

  return { totalValLength, valKeys };
}

getNewValidatorKeys()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
