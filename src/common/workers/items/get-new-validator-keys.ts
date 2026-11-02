import { parentPort, workerData } from 'node:worker_threads';

import { iterateNodesAtDepth } from '@chainsafe/persistent-merkle-tree';
import { ssz } from '@lodestar/types';

import { toHex } from '../../helpers/proofs.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getStateFieldsBytes } from '../../providers/consensus/forks.js';
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
  //
  // Get views
  //
  const { fields } = ssz[state.forkName].BeaconState;
  const validatorsView = fields.validators.deserializeToView(getStateFieldsBytes(state).validators);
  //
  //
  //
  const totalValLength = validatorsView.length;
  const appearedValsCount = totalValLength - lastValidatorsCount;
  if (appearedValsCount === 0) {
    return { totalValLength, valKeys: [] };
  }
  const iterator = iterateNodesAtDepth(
    validatorsView.type.tree_getChunksNode(validatorsView.node),
    validatorsView.type.chunkDepth,
    lastValidatorsCount,
    appearedValsCount,
  );
  const valKeys = [];
  for (let i = lastValidatorsCount; i < totalValLength; i++) {
    const node = iterator.next().value;
    const v = validatorsView.type.elementType.tree_toValue(node);
    valKeys.push(toHex(v.pubkey));
  }
  iterator.return?.();
  return { totalValLength, valKeys };
}

getNewValidatorKeys()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
