import { State } from '../../../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../../providers/consensus/response.interface';
import { KeyInfo } from '../../types';

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
