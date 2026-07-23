import { ForkName } from '@lodestar/params';
import { sszTypesFor } from '@lodestar/types';

const SUPPORTED_FORKS = [ForkName.capella, ForkName.deneb, ForkName.electra, ForkName.fulu, ForkName.gloas] as const;

export type SupportedForkKey = (typeof SUPPORTED_FORKS)[number];
type ForkSsz = ReturnType<typeof sszTypesFor<SupportedForkKey>>;

export type SupportedBlock = ReturnType<ForkSsz['BeaconBlock']['fromJson']>;
export type SupportedBlockView = ReturnType<ForkSsz['BeaconBlock']['toView']>;
export type SupportedStateView = ReturnType<ForkSsz['BeaconState']['toView']>;
export type SupportedWithdrawal = ReturnType<ForkSsz['Withdrawal']['fromJson']>;
export type SupportedValidatorView = ReturnType<ForkSsz['Validator']['toView']>;

export function parseFork(forkName: string): SupportedForkKey {
  if (!(SUPPORTED_FORKS as readonly string[]).includes(forkName)) {
    throw new Error(`Fork name [${forkName}] is not supported`);
  }
  return forkName as SupportedForkKey;
}

export function getSsz(forkName: SupportedForkKey): ForkSsz {
  return sszTypesFor(forkName);
}
