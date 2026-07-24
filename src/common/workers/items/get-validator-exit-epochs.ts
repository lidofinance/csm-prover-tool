import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';

import type { State } from '../../providers/consensus/consensus.js';
import { epochToBigInt } from '../../providers/consensus/epoch.js';
import { getSsz } from '../../providers/consensus/forks.js';
import { WorkerLogger } from '../worker-logger.js';

export type GetValidatorExitEpochsArgs = {
  state: State;
};

export type GetValidatorExitEpochsResult = {
  valExitEpochs: bigint[];
};

async function getValidatorExitEpochs(): Promise<GetValidatorExitEpochsResult> {
  const { state } = workerData as GetValidatorExitEpochsArgs;
  //
  // Get views
  //
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);
  //
  //
  //
  const totalValLength = stateView.validators.length;
  const iterator = iterateNodesAtDepth(
    stateView.validators.type.tree_getChunksNode(stateView.validators.node),
    stateView.validators.type.chunkDepth,
    0,
    totalValLength,
  );
  const valExitEpochs: bigint[] = [];
  for (let i = 0; i < totalValLength; i++) {
    const node = iterator.next().value;
    const v = stateView.validators.type.elementType.tree_toValue(node);
    valExitEpochs.push(epochToBigInt(v.exitEpoch));
  }
  iterator.return && iterator.return();
  return { valExitEpochs };
}

getValidatorExitEpochs()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
