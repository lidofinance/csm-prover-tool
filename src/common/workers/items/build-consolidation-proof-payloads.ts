import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  generateBalanceProof,
  generateHistoricalStateProof,
  generatePendingConsolidationProof,
  generateValidatorProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  verifyProof,
} from '../../helpers/proofs.js';
import type { ConsolidationToProve } from '../../prover/duties/consolidations/consolidations.types.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getSsz, isPostElectraFork } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkerLogger } from '../worker-logger.js';

export type BuildConsolidationProofArgs = {
  recentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  recentState: State;
  consolidationHeader: BlockHeaderResponse;
  consolidationState: State;
  summaryState: State;
  summaryIndex: number;
  rootIndexInSummary: number;
  consolidations: ConsolidationToProve[];
};

async function buildConsolidationProofPayloads(): Promise<IVerifier.ProcessConsolidationInputStruct[]> {
  const {
    recentHeader,
    nextHeaderTimestamp,
    recentState,
    consolidationHeader,
    consolidationState,
    summaryState,
    summaryIndex,
    rootIndexInSummary,
    consolidations,
  } = workerData as BuildConsolidationProofArgs;
  if (!consolidations.length) return [];
  //
  // Get views
  //
  if (!isPostElectraFork(consolidationState.forkName)) {
    throw new Error('Pending consolidations are not available in this fork');
  }
  const recentStateView = getSsz(recentState.forkName).BeaconState.deserializeToView(recentState.bodyBytes);
  const consolidationStateView = getSsz(consolidationState.forkName).BeaconState.deserializeToView(
    consolidationState.bodyBytes,
  );
  const summaryStateView = getSsz(summaryState.forkName).BeaconState.deserializeToView(summaryState.bodyBytes);
  //
  //
  //
  const consolidationOffsets = new Map<string, number>();
  const pendingConsolidationsView = consolidationStateView.pendingConsolidations;
  for (let i = 0; i < pendingConsolidationsView.length; i++) {
    const entry = pendingConsolidationsView.getReadonly(i);
    const key = `${Number(entry.sourceIndex)}:${Number(entry.targetIndex)}`;
    consolidationOffsets.set(key, i);
  }

  WorkerLogger.log('Generating historical consolidation block proof');
  const historicalStateProof = await generateHistoricalStateProof(
    recentStateView,
    summaryStateView,
    summaryIndex,
    rootIndexInSummary,
  );
  WorkerLogger.log('Verifying historical consolidation block proof locally');
  verifyProof(
    recentStateView.hashTreeRoot(),
    historicalStateProof.gindex,
    historicalStateProof.witnesses,
    summaryStateView.blockRoots.getReadonly(rootIndexInSummary),
  );

  const payloads: IVerifier.ProcessConsolidationInputStruct[] = [];
  for (const consolidation of consolidations) {
    const valIndex = consolidation.sourceIndex;
    const keyInfo = consolidation.keyInfo;
    const validator = recentStateView.validators.getReadonly(valIndex);
    if (validator.slashed) {
      WorkerLogger.log(`Invalid validator state to prove [${valIndex}]: it is slashed`);
      throw new Error('Validator is slashed');
    }
    if (toHex(validator.pubkey) != keyInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }

    const consolidationKey = `${consolidation.sourceIndex}:${consolidation.targetIndex}`;
    const consolidationOffset = consolidationOffsets.get(consolidationKey);
    if (consolidationOffset === undefined) {
      throw new Error(`Pending consolidation not found in state: ${consolidationKey}`);
    }

    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = await generateValidatorProof(recentStateView, valIndex);
    WorkerLogger.log(`Generating pending consolidation proof`);
    const pendingConsolidationProof = await generatePendingConsolidationProof(
      consolidationStateView,
      consolidationOffset,
    );
    WorkerLogger.log(`Generating balance proof`);
    const balanceProof = await generateBalanceProof(consolidationStateView, valIndex);
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(
      recentStateView.hashTreeRoot(),
      validatorProof.gindex,
      validatorProof.witnesses,
      validator.hashTreeRoot(),
    );
    WorkerLogger.log('Verifying pending consolidation proof locally');
    verifyProof(
      consolidationStateView.hashTreeRoot(),
      pendingConsolidationProof.gindex,
      pendingConsolidationProof.witnesses,
      pendingConsolidationProof.leaf,
    );
    WorkerLogger.log('Verifying balance proof locally');
    verifyProof(consolidationStateView.hashTreeRoot(), balanceProof.gindex, balanceProof.witnesses, balanceProof.leaf);
    payloads.push({
      consolidation: {
        object: {
          sourceIndex: consolidation.sourceIndex,
          targetIndex: consolidation.targetIndex,
        },
        offset: consolidationOffset,
        proof: pendingConsolidationProof.witnesses.map(toHex),
      },
      validator: {
        index: Number(valIndex),
        nodeOperatorId: keyInfo.operatorId,
        keyIndex: keyInfo.keyIndex,
        object: toValidatorStruct(validator),
        proof: validatorProof.witnesses.map(toHex),
      },
      // Represents the validator's balance before the CL processes the pending consolidation. Used as a proxy for the
      // "withdrawal balance" in accounting/penalties, since consolidation is not an EL withdrawal.
      balance: {
        node: toHex(balanceProof.leaf),
        proof: balanceProof.witnesses.map(toHex),
      },
      recentBlock: {
        header: toBeaconHeaderStruct(recentHeader),
        rootsTimestamp: nextHeaderTimestamp,
      },
      consolidationBlock: {
        header: toBeaconHeaderStruct(consolidationHeader),
        proof: historicalStateProof.witnesses.map(toHex),
      },
    });
  }
  return payloads;
}

buildConsolidationProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
