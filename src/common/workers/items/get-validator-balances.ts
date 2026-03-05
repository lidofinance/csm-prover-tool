import { parentPort, workerData } from 'node:worker_threads';

import type { State } from '../../providers/consensus/consensus.js';
import { getSsz } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetValidatorBalancesArgs = {
  state: State;
};

export type GetValidatorBalancesResult = {
  valBalances: bigint[];
};

async function getValidatorBalances(): Promise<GetValidatorBalancesResult> {
  const { state } = workerData as GetValidatorBalancesArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const totalValLength = stateView.balances.length;
  const valBalances = new Array<bigint>(totalValLength);

  for (let i = 0; i < totalValLength; i++) {
    valBalances[i] = BigInt(stateView.balances.get(i));
  }

  return { valBalances };
}

getValidatorBalances()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
