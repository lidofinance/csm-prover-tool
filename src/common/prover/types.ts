import type { IValidatorStrikes } from '../contracts/types/Strikes.js';

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

export type BadPerformerProofPayload = {
  keyStrikesList: IValidatorStrikes.KeyStrikesStruct[];
  proof: string[]; // bytes32[]
  proofFlags: boolean[];
  refundRecipient?: string; // Optional. Address to receive the refund from ejector contract
};
