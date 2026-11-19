import type { ContractFunctionArgs } from 'viem';

import type { strikesAbi } from '../abi/strikes.js';

export type KeyStrikesStruct = ContractFunctionArgs<
  typeof strikesAbi,
  'payable',
  'processBadPerformanceProof'
>[0][number];
