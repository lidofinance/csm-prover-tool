import { parentPort, workerData } from 'node:worker_threads';

import type { State } from '../../providers/consensus/consensus.js';
import { epochToBigInt } from '../../providers/consensus/epoch.js';
import { getSsz } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetValidatorExitEpochsArgs = {
  state: State;
};

export type GetValidatorExitEpochsResult = {
  slot: number;
  valExitEpochs: bigint[];
  valWithdrawableEpochs: bigint[];
};

async function getValidatorExitEpochs(): Promise<GetValidatorExitEpochsResult> {
  const { state } = workerData as GetValidatorExitEpochsArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const totalValLength = stateView.validators.length;
  const valExitEpochs = new Array<bigint>(totalValLength);
  const valWithdrawableEpochs = new Array<bigint>(totalValLength);

  for (let i = 0; i < totalValLength; i++) {
    const v = stateView.validators.get(i);
    valExitEpochs[i] = epochToBigInt(v.exitEpoch);
    valWithdrawableEpochs[i] = epochToBigInt(v.withdrawableEpoch);
  }

  return { slot: stateView.slot, valExitEpochs, valWithdrawableEpochs };
}

getValidatorExitEpochs()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
