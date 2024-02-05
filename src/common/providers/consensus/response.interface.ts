export type BLSSignature = string;
export type ValidatorIndex = string;
export type RootHex = string;
export type Slot = number;
export type Epoch = number;
export type BlockId = RootHex | Slot | 'head' | 'genesis' | 'finalized';
export type StateId = RootHex | Slot | 'head' | 'genesis' | 'finalized' | 'justified';

export enum ValStatus {
  ActiveOngoing = 'active_ongoing',
  ActiveExiting = 'active_exiting',
  PendingQueued = 'pending_queued',
  PendingInitialized = 'pending_initialized',
  ActiveSlashed = 'active_slashed',
  ExitedSlashed = 'exited_slashed',
  ExitedUnslashed = 'exited_unslashed',
  WithdrawalPossible = 'withdrawal_possible',
  WithdrawalDone = 'withdrawal_done',
}

export interface BlockHeaderResponse {
  root: RootHex;
  canonical: boolean;
  header: {
    message: {
      slot: Slot;
      proposer_index: ValidatorIndex;
      parent_root: RootHex;
      state_root: RootHex;
      body_root: RootHex;
    };
    signature: BLSSignature;
  };
}

export interface BlockInfoResponse {
  message: {
    slot: string;
    proposer_index: ValidatorIndex;
    body: {
      attestations: BeaconBlockAttestation[];
      proposer_slashings: {
        signed_header_1: {
          proposer_index: string;
        };
        signed_header_2: {
          proposer_index: string;
        };
      }[];
      attester_slashings: {
        attestation_1: {
          attesting_indices: string[];
        };
        attestation_2: {
          attesting_indices: string[];
        };
      }[];
      execution_payload: {
        withdrawals: Withdrawal[];
      };
    };
  };
}

export interface Withdrawal {
  index: string;
  validator_index: ValidatorIndex;
  address: string;
  amount: string;
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

export interface BeaconBlockAttestation {
  aggregation_bits: string;
  data: {
    slot: string;
    index: string;
    beacon_block_root: RootHex;
    source: {
      epoch: string;
      root: RootHex;
    };
    target: {
      epoch: string;
      root: RootHex;
    };
  };
}

export interface StateValidatorResponse {
  index: string;
  balance: string;
  status: (typeof ValStatus)[keyof typeof ValStatus];
  validator: {
    pubkey: string;
    withdrawal_credentials: string;
    effective_balance: string;
    slashed: boolean;
    activation_eligibility_epoch: string;
    activation_epoch: string;
    exit_epoch: string;
    withdrawable_epoch: string;
  };
}
