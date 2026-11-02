import { ForkName } from '@lodestar/params';
import { ssz, sszTypesFor } from '@lodestar/types';

import type { State } from './consensus.js';

const SUPPORTED_FORKS = [ForkName.capella, ForkName.deneb, ForkName.electra, ForkName.fulu] as const;

export type SupportedForkKey = (typeof SUPPORTED_FORKS)[number];
type ForkSsz = ReturnType<typeof sszTypesFor<SupportedForkKey>>;
type StateFields = (typeof ssz)[SupportedForkKey]['BeaconState']['fields'];

export type SupportedBlock = ReturnType<ForkSsz['BeaconBlock']['fromJson']>;
export type SupportedBlockView = ReturnType<ForkSsz['BeaconBlock']['toView']>;
export type SupportedStateView = ReturnType<ForkSsz['BeaconState']['toView']>;
export type SupportedWithdrawal = ReturnType<ForkSsz['Withdrawal']['fromJson']>;
export type SupportedValidatorView = ReturnType<ForkSsz['Validator']['toView']>;
export type SupportedBlockRootsView = SupportedStateView['blockRoots'];

export function parseFork(forkName: string): SupportedForkKey {
  if (!(SUPPORTED_FORKS as readonly string[]).includes(forkName)) {
    throw new Error(`Fork name [${forkName}] is not supported`);
  }
  return forkName as SupportedForkKey;
}

export function getSsz(forkName: SupportedForkKey): ForkSsz {
  return sszTypesFor(forkName);
}

export function getStateFieldsBytes(state: State): Record<keyof StateFields, Uint8Array> {
  const { bodyBytes, forkName } = state;
  const stateType = ssz[forkName].BeaconState;
  const view = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength);
  const ranges = stateType.getFieldRanges(view, 0, bodyBytes.byteLength);
  return Object.fromEntries(
    stateType.fieldsEntries.map(({ fieldName }, i) => [fieldName, bodyBytes.subarray(ranges[i].start, ranges[i].end)]),
  ) as Record<keyof StateFields, Uint8Array>;
}
