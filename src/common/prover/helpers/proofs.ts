import { createHash } from 'node:crypto';

import { ProofType, SingleProof, concatGindices, createProof } from '@chainsafe/persistent-merkle-tree';
import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;

export function generateValidatorProof(
  stateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
  valIndex: number,
): SingleProof {
  const gI = stateView.type.getPathInfo(['validators', Number(valIndex)]).gindex;
  return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

export function generateWithdrawalProof(
  stateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
  blockView: ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>,
  withdrawalOffset: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = (stateView as any).tree.clone();
  const stateWdGindex = stateView.type.getPathInfo(['latestExecutionPayloadHeader', 'withdrawalsRoot']).gindex;
  patchedTree.setNode(
    stateWdGindex,
    (blockView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>).body.executionPayload.withdrawals.node,
  );
  const withdrawalGI = (
    blockView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
  ).body.executionPayload.withdrawals.type.getPropertyGindex(withdrawalOffset) as bigint;
  const gI = concatGindices([stateWdGindex, withdrawalGI]);
  return createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
}

export function generateHistoricalStateProof(
  finalizedStateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
  summaryStateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
  summaryIndex: number,
  rootIndex: number,
): SingleProof {
  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = (finalizedStateView as any).tree.clone();
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
