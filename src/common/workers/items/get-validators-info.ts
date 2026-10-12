import { parentPort, workerData } from 'node:worker_threads';

import type { State } from '../../providers/consensus/consensus.js';
import { epochToBigInt } from '../../providers/consensus/epoch.js';
import { getSsz } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetValidatorsInfoArgs = {
  state: State;
  indices: number[];
};

export type ValidatorInfo = {
  balance: bigint;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
};

export type GetValidatorsInfoResult = {
  slot: number;
  validators: Record<number, ValidatorInfo>;
};

async function getValidatorsInfo(): Promise<GetValidatorsInfoResult> {
  const { state, indices } = workerData as GetValidatorsInfoArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const totalValLength = stateView.validators.length;
  const validators: Record<number, ValidatorInfo> = {};

  for (const i of indices) {
    if (i >= totalValLength) continue;
    const v = stateView.validators.get(i);
    validators[i] = {
      balance: BigInt(stateView.balances.get(i)),
      exitEpoch: epochToBigInt(v.exitEpoch),
      withdrawableEpoch: epochToBigInt(v.withdrawableEpoch),
    };
  }

  return { slot: stateView.slot, validators };
}

getValidatorsInfo()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
