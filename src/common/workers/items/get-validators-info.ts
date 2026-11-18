import { parentPort, workerData } from 'node:worker_threads';

import { ssz } from '@lodestar/types';

import type { State } from '../../providers/consensus/consensus.js';
import { epochToBigInt } from '../../providers/consensus/epoch.js';
import { getStateFieldsBytes } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetValidatorsInfoArgs = {
  state: State;
  indices: number[];
};

export type ValidatorInfo = {
  balance: bigint;
  slashed: boolean;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
};

export type GetValidatorsInfoResult = {
  slot: number;
  validators: Record<number, ValidatorInfo>;
};

async function getValidatorsInfo(): Promise<GetValidatorsInfoResult> {
  const { state, indices } = workerData as GetValidatorsInfoArgs;
  const { fields } = ssz[state.forkName].BeaconState;
  const bytes = getStateFieldsBytes(state);
  const slot = fields.slot.deserialize(bytes.slot);
  const validatorsView = fields.validators.deserializeToView(bytes.validators);
  const balancesView = fields.balances.deserializeToView(bytes.balances);

  const totalValLength = validatorsView.length;
  const validators: Record<number, ValidatorInfo> = {};

  for (const i of indices) {
    if (i >= totalValLength) continue;
    const v = validatorsView.getReadonly(i);
    validators[i] = {
      balance: BigInt(balancesView.get(i)),
      slashed: v.slashed,
      exitEpoch: epochToBigInt(v.exitEpoch),
      withdrawableEpoch: epochToBigInt(v.withdrawableEpoch),
    };
  }

  return { slot, validators };
}

getValidatorsInfo()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
