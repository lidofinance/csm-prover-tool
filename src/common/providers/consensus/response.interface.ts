export type BLSSignature = string;
export type ValidatorIndex = string;
export type RootHex = string;
export type Slot = number;
export type BlockId = RootHex | Slot | 'head' | 'genesis' | 'finalized';
export type StateId = RootHex | Slot | 'head' | 'genesis' | 'finalized' | 'justified';

export interface BlockHeaderResponse {
  root: RootHex;
  canonical: boolean;
  header: {
    message: {
      slot: string;
      proposer_index: ValidatorIndex;
      parent_root: RootHex;
      state_root: RootHex;
      body_root: RootHex;
    };
    signature: BLSSignature;
  };
}

export interface GenesisResponse {
  /**
   * example: 1590832934
   * The genesis_time configured for the beacon node, which is the unix time in seconds at which the Eth2.0 chain began.
   */
  genesis_time: string;

  /**
   * example: 0xcf8e0d4e9587369b2301d0790347320302cc0943d5a1884560367e8208d920f2
   * pattern: ^0x[a-fA-F0-9]{64}$
   */
  genesis_validators_root: string;

  /**
   * example: 0x00000000
   * pattern: ^0x[a-fA-F0-9]{8}$
   * a fork version number
   */
  genesis_fork_version: string;
}

export interface BeaconConfig {
  SLOTS_PER_EPOCH: string;
  SECONDS_PER_SLOT: string;
  CAPELLA_FORK_EPOCH: string;
  ETH1_FOLLOW_DISTANCE: string;
  EPOCHS_PER_ETH1_VOTING_PERIOD: string;
  SLOTS_PER_HISTORICAL_ROOT: string;
  MIN_VALIDATOR_WITHDRAWABILITY_DELAY: string;
}
