import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';
import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import { ForkName } from '@lodestar/params';

import { toHex } from '../../helpers/proofs';
import { State } from '../../providers/consensus/consensus';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: (typeof ssz)[ForkName];

export type GetValidatorsArgs = {
  state: State;
  lastValidatorsCount: number;
};

export type GetValidatorsResult = {
  totalValLength: number;
  valKeys: string[];
};

async function getValidators(): Promise<GetValidatorsResult> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { state, lastValidatorsCount } = workerData as GetValidatorsArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName as keyof typeof ForkName].BeaconState.deserializeToView(
    state.bodyBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;
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

getValidators()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
