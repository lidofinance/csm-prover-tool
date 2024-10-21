import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';
import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';

import { toHex } from '../../helpers/proofs';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;
let ForkName: typeof import('@lodestar/params').ForkName;

export type GetValidatorsResult = {
  totalValLength: number;
  valKeys: string[];
};

async function getValidators(): Promise<void> {
  const { stateBytes, stateForkName, lastValidatorsCount } = workerData;
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const stateView = ssz[stateForkName as keyof typeof ForkName].BeaconState.deserializeToView(
    stateBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;

  const totalValLength = stateView.validators.length;
  const appearedValsCount = totalValLength - lastValidatorsCount;
  if (appearedValsCount === 0) {
    parentPort?.postMessage([totalValLength, []]);
    return;
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
  parentPort?.postMessage({ totalValLength, valKeys } as GetValidatorsResult);
}

getValidators().catch((e) => {
  console.error(e);
  throw e;
});
