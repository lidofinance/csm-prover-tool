import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';

import { toHex } from '../../helpers/proofs';
import { State } from '../../providers/consensus/consensus';

let ssz: typeof import('@lodestar/types').ssz;

export type GetNewValidatorKeysArgs = {
  state: State;
  lastValidatorsCount: number;
};

export type GetNewValidatorKeysResult = {
  totalValLength: number;
  valKeys: string[];
};

async function getNewValidatorKeys(): Promise<GetNewValidatorKeysResult> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { state, lastValidatorsCount } = workerData as GetNewValidatorKeysArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  //
  //
  //
  const totalValLength = stateView.validators.length;
  const appearedValsCount = totalValLength - lastValidatorsCount;
  if (appearedValsCount === 0) {
    return { totalValLength, valKeys: [] };
  }
  const iterator = iterateNodesAtDepth(
    stateView.validators.type.tree_getChunksNode(stateView.validators.node),
    stateView.validators.type.chunkDepth,
    lastValidatorsCount,
    appearedValsCount,
  );
  const valKeys = [];
  for (let i = lastValidatorsCount; i < totalValLength; i++) {
    const node = iterator.next().value;
    const v = stateView.validators.type.elementType.tree_toValue(node);
    valKeys.push(toHex(v.pubkey));
  }
  iterator.return && iterator.return();
  return { totalValLength, valKeys };
}

getNewValidatorKeys()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
