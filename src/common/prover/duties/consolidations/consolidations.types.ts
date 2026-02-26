import type { RootHex } from '@lodestar/types';

import type { State } from '../../../providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../../providers/consensus/response.interface.js';
import type { KeyInfo } from '../../types.js';

export type ConsolidationToProve = {
  sourceIndex: number;
  targetIndex: number;
  consolidationBlockRoot: RootHex;
  keyInfo: KeyInfo;
};

export type ConsolidationProofContext = {
  consolidationHeader: BlockHeaderResponse;
  consolidationState: State;
  summaryState: State;
  summaryIndex: number;
  rootIndexInSummary: number;
};
