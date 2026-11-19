import type { ContractFunctionArgs } from 'viem';

import type { verifierAbi } from '../abi/verifier.js';

export type ProcessSlashedInputStruct = ContractFunctionArgs<
  typeof verifierAbi,
  'nonpayable',
  'processSlashedProof'
>[0];
export type ProcessWithdrawalInputStruct = ContractFunctionArgs<
  typeof verifierAbi,
  'nonpayable',
  'processWithdrawalProof'
>[0];
export type ProcessHistoricalWithdrawalInputStruct = ContractFunctionArgs<
  typeof verifierAbi,
  'nonpayable',
  'processHistoricalWithdrawalProof'
>[0];
export type ProcessBalanceProofInputStruct = ContractFunctionArgs<
  typeof verifierAbi,
  'nonpayable',
  'processBalanceProof'
>[0];
export type ProcessHistoricalBalanceProofInputStruct = ContractFunctionArgs<
  typeof verifierAbi,
  'nonpayable',
  'processHistoricalBalanceProof'
>[0];

export type BeaconBlockHeaderStruct = ProcessSlashedInputStruct['recentBlock']['header'];
export type ValidatorStruct = ProcessSlashedInputStruct['validator']['object'];
export type WithdrawalStruct = ProcessWithdrawalInputStruct['withdrawal']['object'];
