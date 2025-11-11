import { ICSStrikes } from '../contracts/types/Strikes';

export interface KeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: string;
}

export interface FullKeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: string;
  validatorIndex: number;
}

export type KeyInfoFn = (valIndex: number) => KeyInfo | undefined;

export type FullKeyInfoByPubKeyFn = (pubKey: string) => FullKeyInfo | undefined;

export type WithdrawalsProofPayload = {
  beaconBlock: ProvableBeaconBlockHeader;
  witness: WithdrawalWitness;
  nodeOperatorId: number;
  keyIndex: number;
};

export type HistoricalWithdrawalsProofPayload = {
  beaconBlock: ProvableBeaconBlockHeader;
  oldBlock: HistoricalHeaderWitness;
  witness: WithdrawalWitness;
  nodeOperatorId: number;
  keyIndex: number;
};

export type BadPerformerProofPayload = {
  keyStrikesList: ICSStrikes.KeyStrikesStruct[];
  proof: string[]; // bytes32[]
  proofFlags: boolean[];
  refundRecipient?: string; // Optional. Address to receive the refund from ejector contract
};

export type ProvableBeaconBlockHeader = {
  header: BeaconBlockHeader;
  rootsTimestamp: number;
};

export type HistoricalHeaderWitness = {
  header: BeaconBlockHeader;
  proof: string[]; // bytes32[]
};

export type BeaconBlockHeader = {
  slot: number;
  proposerIndex: number;
  parentRoot: string; // bytes32
  stateRoot: string; // bytes32
  bodyRoot: string; // bytes32
};

export type WithdrawalWitness = {
  withdrawalOffset: number;
  withdrawalIndex: number;
  validatorIndex: number;
  amount: number;
  withdrawalCredentials: string; // bytes32
  effectiveBalance: number;
  slashed: boolean;
  activationEligibilityEpoch: number;
  activationEpoch: number;
  exitEpoch: number;
  withdrawableEpoch: number;
  withdrawalProof: string[]; // bytes32[]
  validatorProof: string[]; // bytes32[]
};
