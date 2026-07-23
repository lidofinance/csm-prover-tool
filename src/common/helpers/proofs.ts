import { createHash } from 'node:crypto';

import { ProofType, type SingleProof, Tree, concatGindices, createProof } from '@chainsafe/persistent-merkle-tree';
import type { BlockTag } from '@ethersproject/abstract-provider';
import { ForkName } from '@lodestar/params';
import { type RootHex, ssz } from '@lodestar/types';

import type { BeaconBlockHeaderStruct, ValidatorStruct, WithdrawalStruct } from '../contracts/types/Verifier.js';
import { epochToBigInt } from '../providers/consensus/epoch.js';
import type {
  SupportedBlockView,
  SupportedForkKey,
  SupportedStateView,
  SupportedValidatorView,
  SupportedWithdrawal,
} from '../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../providers/consensus/response.interface.js';

export async function generateValidatorProof(stateView: SupportedStateView, valIndex: number): Promise<SingleProof> {
  const gI = stateView.type.getPathInfo(['validators', Number(valIndex)]).gindex;
  return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

export async function generateWithdrawalProof(
  stateView: SupportedStateView,
  blockView: SupportedBlockView,
  withdrawalOffset: number,
  forkName: SupportedForkKey,
): Promise<SingleProof> {
  if (forkName === ForkName.gloas) {
    const gI = stateView.type.getPathInfo(['payloadExpectedWithdrawals', withdrawalOffset]).gindex;
    return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
  }

  // NOTE: ugly hack to replace root with the value to make a proof
  const patchedTree = new Tree(stateView.node);
  const stateWdGindex = stateView.type.getPathInfo(['latestExecutionPayloadHeader', 'withdrawalsRoot']).gindex;
  if (!('executionPayload' in blockView.body)) throw new Error('Execution payload is missing before Gloas');
  const withdrawals = blockView.body.executionPayload.withdrawals;
  patchedTree.setNode(stateWdGindex, withdrawals.node);
  const withdrawalGI = withdrawals.type.getPropertyGindex(withdrawalOffset) as bigint;
  const gI = concatGindices([stateWdGindex, withdrawalGI]);
  return createProof(patchedTree.rootNode, {
    type: ProofType.single,
    gindex: gI,
  }) as SingleProof;
}

export async function generateBlockRootsProof(
  recentStateView: SupportedStateView,
  withdrawalSlot: number,
): Promise<SingleProof> {
  const rootIndex = withdrawalSlot % recentStateView.blockRoots.length;
  const gI = recentStateView.type.getPathInfo(['blockRoots', rootIndex]).gindex;
  return createProof(recentStateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

export function getWithdrawalView(
  stateView: SupportedStateView,
  blockView: SupportedBlockView,
  withdrawalOffset: number,
  forkName: SupportedForkKey,
) {
  if (forkName === ForkName.gloas) {
    if (!('payloadExpectedWithdrawals' in stateView)) {
      throw new Error('Expected withdrawals are missing in Gloas state');
    }
    return stateView.payloadExpectedWithdrawals.get(withdrawalOffset);
  }
  if (!('executionPayload' in blockView.body)) throw new Error('Execution payload is missing before Gloas');
  return blockView.body.executionPayload.withdrawals.get(withdrawalOffset);
}

export function beaconHeaderRoot(header: BlockHeaderResponse): Uint8Array {
  return ssz.phase0.BeaconBlockHeader.hashTreeRoot(header.header.message);
}

export async function generateBalanceProof(
  stateView: SupportedStateView,
  validatorIndex: number,
): Promise<SingleProof> {
  const gI = stateView.type.getPathInfo(['balances', validatorIndex]).gindex;
  return createProof(stateView.node, { type: ProofType.single, gindex: gI }) as SingleProof;
}

export async function generateHistoricalStateProof(
  finalizedStateView: SupportedStateView,
  summaryStateView: SupportedStateView,
  summaryIndex: number,
  rootIndex: number,
): Promise<SingleProof> {
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

export function toBlockTagByHash(hashBytes: Uint8Array): BlockTag {
  return { blockHash: toHex(hashBytes) } as unknown as BlockTag;
}

export function toRootHex(value: RootHex | Uint8Array): RootHex {
  return typeof value === 'string' ? value : toHex(value);
}

export function toBeaconHeaderStruct(header: BlockHeaderResponse): BeaconBlockHeaderStruct {
  const message = header.header.message;
  return {
    slot: Number(message.slot),
    proposerIndex: Number(message.proposerIndex),
    parentRoot: toHex(message.parentRoot),
    stateRoot: toHex(message.stateRoot),
    bodyRoot: toHex(message.bodyRoot),
  };
}

export function toValidatorStruct(validator: SupportedValidatorView): ValidatorStruct {
  return {
    pubkey: toHex(validator.pubkey),
    withdrawalCredentials: toHex(validator.withdrawalCredentials),
    effectiveBalance: BigInt(validator.effectiveBalance),
    slashed: Boolean(validator.slashed),
    activationEligibilityEpoch: epochToBigInt(validator.activationEligibilityEpoch),
    activationEpoch: epochToBigInt(validator.activationEpoch),
    exitEpoch: epochToBigInt(validator.exitEpoch),
    withdrawableEpoch: epochToBigInt(validator.withdrawableEpoch),
  };
}

export function toWithdrawalStruct(withdrawal: SupportedWithdrawal): WithdrawalStruct {
  return {
    index: Number(withdrawal.index),
    validatorIndex: Number(withdrawal.validatorIndex),
    withdrawalAddress: toHex(withdrawal.address),
    amount: BigInt(withdrawal.amount),
  };
}
