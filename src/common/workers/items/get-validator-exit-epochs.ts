import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';

import { State } from '../../providers/consensus/consensus';

let ssz: typeof import('@lodestar/types').ssz;

export type GetValidatorExitEpochsArgs = {
  state: State;
};

export type GetValidatorExitEpochsResult = {
  valExitEpochs: number[];
};

async function getValidatorExitEpochs(): Promise<GetValidatorExitEpochsResult> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { state } = workerData as GetValidatorExitEpochsArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
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
  const valExitEpochs = [];
  for (let i = 0; i < totalValLength; i++) {
    const node = iterator.next().value;
    const v = stateView.validators.type.elementType.tree_toValue(node);
    valExitEpochs.push(v.exitEpoch);
  }
  iterator.return && iterator.return();
  return { valExitEpochs };
}

getValidatorExitEpochs()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
