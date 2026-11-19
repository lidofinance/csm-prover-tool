import type { Abi } from 'viem';

export const ejectorAbi = [
  {
    type: 'function',
    name: 'triggerableWithdrawalsGateway',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
] as const satisfies Abi;
