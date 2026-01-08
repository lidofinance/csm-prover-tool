import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import { IVerifier } from '../../contracts/types/Verifier';
import {
  generateHistoricalStateProof,
  generateValidatorProof,
  generateWithdrawalProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  toWithdrawalStruct,
  verifyProof,
} from '../../helpers/proofs';
import { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service';
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

async function buildHistoricalWithdrawalsProofPayloads(): Promise<IVerifier.ProcessHistoricalWithdrawalInputStruct[]> {
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
    if (toHex(validator.pubkey) != keyWithWithdrawalInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyWithWithdrawalInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }
    if (epoch < validator.withdrawableEpoch) {
      WorkerLogger.warn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
      continue;
    }
    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = await generateValidatorProof(stateWithWdsView, Number(valIndex));
    WorkerLogger.log('Generating withdrawal proof');
    const withdrawalProof = await generateWithdrawalProof(
      stateWithWdsView,
      blockWithWdsView,
      keyWithWithdrawalInfo.withdrawal.offset,
    );
    WorkerLogger.log('Generating historical state proof');
    const historicalStateProof = await generateHistoricalStateProof(
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
      withdrawal: {
        offset: Number(keyWithWithdrawalInfo.withdrawal.offset),
        object: toWithdrawalStruct(keyWithWithdrawalInfo.withdrawal),
        proof: withdrawalProof.witnesses.map(toHex),
      },
      validator: {
        index: Number(valIndex),
        nodeOperatorId: keyWithWithdrawalInfo.operatorId,
        keyIndex: keyWithWithdrawalInfo.keyIndex,
        object: toValidatorStruct(validator),
        proof: validatorProof.witnesses.map(toHex),
      },
      recentBlock: {
        header: toBeaconHeaderStruct(finalHeader),
        rootsTimestamp: nextToFinalizedHeaderTimestamp,
      },
      withdrawalBlock: {
        header: toBeaconHeaderStruct(headerWithWds),
        proof: historicalStateProof.witnesses.map(toHex),
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
