import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import {
  generateHistoricalStateProof,
  generateValidatorProof,
  generateWithdrawalProof,
  toHex,
  verifyProof,
} from '../../helpers/proofs';
import { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service';
import { HistoricalWithdrawalsProofPayload } from '../../prover/types';
import { State, SupportedBlock } from '../../providers/consensus/consensus';
import { BlockHeaderResponse } from '../../providers/consensus/response.interface';
import { WorkerLogger } from '../workers.service';

let ssz: typeof sszType;

export type BuildHistoricalWithdrawalProofArgs = {
  headerWithWds: BlockHeaderResponse;
  finalHeader: BlockHeaderResponse;
  nextToFinalizedHeaderTimestamp: number;
  finalizedState: State;
  summaryState: State;
  stateWithWds: State;
  blockWithWds: SupportedBlock;
  summaryIndex: number;
  rootIndexInSummary: number;
  withdrawals: InvolvedKeysWithWithdrawal;
  epoch: number;
};

async function buildHistoricalWithdrawalsProofPayloads(): Promise<HistoricalWithdrawalsProofPayload[]> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const {
    headerWithWds,
    finalHeader,
    nextToFinalizedHeaderTimestamp,
    finalizedState,
    summaryState,
    stateWithWds,
    blockWithWds,
    summaryIndex,
    rootIndexInSummary,
    withdrawals,
    epoch,
  } = workerData as BuildHistoricalWithdrawalProofArgs;
  //
  // Get views
  //
  const finalizedStateView = ssz[finalizedState.forkName].BeaconState.deserializeToView(finalizedState.bodyBytes);
  const summaryStateView = ssz[summaryState.forkName].BeaconState.deserializeToView(summaryState.bodyBytes);
  const stateWithWdsView = ssz[stateWithWds.forkName].BeaconState.deserializeToView(stateWithWds.bodyBytes);
  // @ts-expect-error: thinks state can have different fork with currentBlock, but it's not possible
  const blockWithWdsView = ssz[stateWithWds.forkName].BeaconBlock.toView(blockWithWds);
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
    const validator = stateWithWdsView.validators.getReadonly(Number(valIndex));
    if (epoch < validator.withdrawableEpoch) {
      WorkerLogger.warn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
      continue;
    }
    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = generateValidatorProof(stateWithWdsView, Number(valIndex));
    WorkerLogger.log('Generating withdrawal proof');
    const withdrawalProof = generateWithdrawalProof(
      stateWithWdsView,
      blockWithWdsView,
      keyWithWithdrawalInfo.withdrawal.offset,
    );
    WorkerLogger.log('Generating historical state proof');
    const historicalStateProof = generateHistoricalStateProof(
      finalizedStateView,
      summaryStateView,
      summaryIndex,
      rootIndexInSummary,
    );
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(
      stateWithWdsView.hashTreeRoot(),
      validatorProof.gindex,
      validatorProof.witnesses,
      validator.hashTreeRoot(),
    );
    WorkerLogger.log('Verifying withdrawal proof locally');
    verifyProof(
      stateWithWdsView.hashTreeRoot(),
      withdrawalProof.gindex,
      withdrawalProof.witnesses,
      blockWithWdsView.body.executionPayload.withdrawals
        .getReadonly(keyWithWithdrawalInfo.withdrawal.offset)
        .hashTreeRoot(),
    );
    WorkerLogger.log('Verifying historical state proof locally');
    verifyProof(
      finalizedStateView.hashTreeRoot(),
      historicalStateProof.gindex,
      historicalStateProof.witnesses,
      summaryStateView.blockRoots.getReadonly(rootIndexInSummary),
    );
    payloads.push({
      keyIndex: keyWithWithdrawalInfo.keyIndex,
      nodeOperatorId: keyWithWithdrawalInfo.operatorId,
      beaconBlock: {
        header: {
          slot: finalHeader.header.message.slot,
          proposerIndex: Number(finalHeader.header.message.proposer_index),
          parentRoot: finalHeader.header.message.parent_root,
          stateRoot: finalHeader.header.message.state_root,
          bodyRoot: finalHeader.header.message.body_root,
        },
        rootsTimestamp: nextToFinalizedHeaderTimestamp,
      },
      oldBlock: {
        header: {
          slot: headerWithWds.header.message.slot,
          proposerIndex: Number(headerWithWds.header.message.proposer_index),
          parentRoot: headerWithWds.header.message.parent_root,
          stateRoot: headerWithWds.header.message.state_root,
          bodyRoot: headerWithWds.header.message.body_root,
        },
        // NOTE: the last byte can be changed due to `CSVerifier` implementation in the future
        rootGIndex: '0x' + (historicalStateProof.gindex.toString(16) + '00').padStart(64, '0'),
        proof: historicalStateProof.witnesses.map(toHex),
      },
      witness: {
        withdrawalOffset: Number(keyWithWithdrawalInfo.withdrawal.offset),
        withdrawalIndex: Number(keyWithWithdrawalInfo.withdrawal.index),
        validatorIndex: Number(keyWithWithdrawalInfo.withdrawal.validatorIndex),
        amount: Number(keyWithWithdrawalInfo.withdrawal.amount),
        withdrawalCredentials: toHex(validator.withdrawalCredentials),
        effectiveBalance: validator.effectiveBalance,
        slashed: Boolean(validator.slashed),
        activationEligibilityEpoch: validator.activationEligibilityEpoch,
        activationEpoch: validator.activationEpoch,
        exitEpoch: validator.exitEpoch,
        withdrawableEpoch: validator.withdrawableEpoch,
        withdrawalProof: withdrawalProof.witnesses.map(toHex),
        validatorProof: validatorProof.witnesses.map(toHex),
      },
    });
  }
  return payloads;
}

buildHistoricalWithdrawalsProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
