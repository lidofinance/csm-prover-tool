import type { Address, Hex } from 'viem';

export type BeaconBlockHeaderStruct = {
  slot: bigint;
  proposerIndex: bigint;
  parentRoot: Hex;
  stateRoot: Hex;
  bodyRoot: Hex;
};

export type ValidatorStruct = {
  pubkey: Hex;
  withdrawalCredentials: Hex;
  effectiveBalance: bigint;
  slashed: boolean;
  activationEligibilityEpoch: bigint;
  activationEpoch: bigint;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
};

export type WithdrawalStruct = {
  index: bigint;
  validatorIndex: bigint;
  withdrawalAddress: Address;
  amount: bigint;
};

type ValidatorWitnessStruct = {
  index: bigint;
  nodeOperatorId: number;
  keyIndex: number;
  object: ValidatorStruct;
  proof: readonly Hex[];
};

type RecentHeaderWitnessStruct = {
  header: BeaconBlockHeaderStruct;
  rootsTimestamp: bigint;
};

type HistoricalHeaderWitnessStruct = {
  header: BeaconBlockHeaderStruct;
  proof: readonly Hex[];
};

type WithdrawalWitnessStruct = {
  offset: number;
  object: WithdrawalStruct;
  proof: readonly Hex[];
};

type BalanceWitnessStruct = {
  node: Hex;
  proof: readonly Hex[];
};

export type ProcessSlashedInputStruct = {
  validator: ValidatorWitnessStruct;
  recentBlock: RecentHeaderWitnessStruct;
};

export type ProcessWithdrawalInputStruct = {
  withdrawal: WithdrawalWitnessStruct;
  validator: ValidatorWitnessStruct;
  withdrawalBlock: RecentHeaderWitnessStruct;
};

export type ProcessHistoricalWithdrawalInputStruct = {
  withdrawal: WithdrawalWitnessStruct;
  validator: ValidatorWitnessStruct;
  recentBlock: RecentHeaderWitnessStruct;
  withdrawalBlock: HistoricalHeaderWitnessStruct;
};

export type ProcessBalanceProofInputStruct = {
  recentBlock: RecentHeaderWitnessStruct;
  validator: ValidatorWitnessStruct;
  balance: BalanceWitnessStruct;
};

export type ProcessHistoricalBalanceProofInputStruct = {
  recentBlock: RecentHeaderWitnessStruct;
  historicalBlock: HistoricalHeaderWitnessStruct;
  validator: ValidatorWitnessStruct;
  balance: BalanceWitnessStruct;
};

export type ProcessWithdrawnInputStruct = {
  validator: ValidatorWitnessStruct;
  recentBlock: RecentHeaderWitnessStruct;
};

export type KeyStrikesStruct = {
  nodeOperatorId: bigint;
  keyIndex: bigint;
  data: readonly bigint[];
};
