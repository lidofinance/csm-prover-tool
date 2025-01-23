import { createHash } from 'node:crypto';

import { ProofType, SingleProof, Tree, concatGindices, createProof } from '@chainsafe/persistent-merkle-tree';
import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import type { ssz as sszType } from '@lodestar/types';

let ssz: typeof sszType;

export type SupportedStateView =
  | ContainerTreeViewType<typeof ssz.capella.BeaconState.fields>
  | ContainerTreeViewType<typeof ssz.deneb.BeaconState.fields>
  | ContainerTreeViewType<typeof ssz.electra.BeaconState.fields>;

export type SupportedBlockView =
  | ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
  | ContainerTreeViewType<typeof ssz.deneb.BeaconBlock.fields>
  | ContainerTreeViewType<typeof ssz.electra.BeaconBlock.fields>;

export function generateValidatorProof(stateView: SupportedStateView, valIndex: number): SingleProof {
  const gI = stateView.type.getPathInfo(['validators', Number(valIndex)]).gindex;
  return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

export function generateWithdrawalProof(
  stateView: SupportedStateView,
  blockView: SupportedBlockView,
  withdrawalOffset: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = new Tree(stateView.node);
  const stateWdGindex = stateView.type.getPathInfo(['latestExecutionPayloadHeader', 'withdrawalsRoot']).gindex;
  patchedTree.setNode(stateWdGindex, blockView.body.executionPayload.withdrawals.node);
  const withdrawalGI = blockView.body.executionPayload.withdrawals.type.getPropertyGindex(withdrawalOffset) as bigint;
  const gI = concatGindices([stateWdGindex, withdrawalGI]);
  return createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
}

export function generateHistoricalStateProof(
  finalizedStateView: SupportedStateView,
  summaryStateView: SupportedStateView,
  summaryIndex: number,
  rootIndex: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = new Tree(finalizedStateView.node);
  const blockSummaryRootGI = finalizedStateView.type.getPathInfo([
    'historicalSummaries',
    summaryIndex,
    'blockSummaryRoot',
  ]).gindex;
  patchedTree.setNode(blockSummaryRootGI, summaryStateView.blockRoots.node);
  const blockRootsGI = summaryStateView.blockRoots.type.getPropertyGindex(rootIndex) as bigint;
  const gI = concatGindices([blockSummaryRootGI, blockRootsGI]);
  return createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
}

// port of https://github.com/ethereum/go-ethereum/blob/master/beacon/merkle/merkle.go
export function verifyProof(root: Uint8Array, gI: bigint, proof: Uint8Array[], value: Uint8Array) {
  let buf = value;

  proof.forEach((p) => {
    const hasher = createHash('sha256');
    if (gI % 2n == 0n) {
      hasher.update(buf);
      hasher.update(p);
    } else {
      hasher.update(p);
      hasher.update(buf);
    }
    buf = hasher.digest();
    gI >>= 1n;
    if (gI == 0n) {
      throw new Error('Branch has extra item');
    }
  });

  if (gI != 1n) {
    throw new Error('Branch is missing items');
  }

  if (toHex(root) != toHex(buf)) {
    throw new Error('Proof is not valid');
  }
}

export function toHex(value: Uint8Array) {
  return '0x' + Buffer.from(value).toString('hex');
}
