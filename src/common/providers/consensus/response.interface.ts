import type { RootHex, Slot, phase0 } from '@lodestar/types';

const DYNAMIC_BLOCK_IDS = ['head', 'finalized'] as const;
const DYNAMIC_STATE_IDS = [...DYNAMIC_BLOCK_IDS, 'justified'] as const;

export type DynamicBlockId = (typeof DYNAMIC_BLOCK_IDS)[number];
export type DynamicStateId = (typeof DYNAMIC_STATE_IDS)[number];

export type BlockId = RootHex | Slot | DynamicBlockId | 'genesis';
export type StateId = RootHex | Slot | DynamicStateId | 'genesis';

export function isDynamicBlockId(id: unknown): id is DynamicBlockId {
  return isOneOf(id, DYNAMIC_BLOCK_IDS);
}

export function isDynamicStateId(id: unknown): id is DynamicStateId {
  return isOneOf(id, DYNAMIC_STATE_IDS);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export type BlockHeaderResponse = {
  root: RootHex;
  canonical: boolean;
  header: phase0.SignedBeaconBlockHeader;
};

export type BeaconHeadersByParentRootResponse = {
  finalized: boolean;
  data: BlockHeaderResponse[];
};
