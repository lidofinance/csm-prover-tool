import type { ContractFunctionArgs } from 'viem';

import type { curatedVerifierAbi } from '../abi/curated-verifier.js';

export type ProcessWithdrawnInputStruct = ContractFunctionArgs<
  typeof curatedVerifierAbi,
  'nonpayable',
  'processWithdrawnProof'
>[0];
