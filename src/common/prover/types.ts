import type { Hex } from 'viem';

import type { KeyStrikesStruct } from '../contracts/structs.js';

export interface KeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: Hex;
}

export interface FullKeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: Hex;
  validatorIndex: number;
}

export type KeyInfoFn = (valIndex: number) => KeyInfo | undefined;

export type FullKeyInfoByPubKeyFn = (pubKey: string) => FullKeyInfo | undefined;

export type BadPerformerProofPayload = {
  keyStrikesList: KeyStrikesStruct[];
  proof: Hex[]; // bytes32[]
  proofFlags: boolean[];
  refundRecipient?: string; // Optional. Address to receive the refund from ejector contract
};
