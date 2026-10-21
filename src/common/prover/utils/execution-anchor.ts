import { toRootHex } from '../../helpers/proofs.js';
import { type Consensus, type State } from '../../providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { type Execution } from '../../providers/execution/execution.js';

export type ExecutionAnchor = { header: BlockHeaderResponse; state: State; timestamp: number };

export async function getExecutionAnchor(execution: Execution, consensus: Consensus): Promise<ExecutionAnchor> {
  const { root, timestamp } = await execution.getFinalizedBeaconAnchor();
  const header = await consensus.getBeaconHeader(root);
  const state = await consensus.getState(toRootHex(header.header.message.stateRoot));
  return { header, state, timestamp };
}
