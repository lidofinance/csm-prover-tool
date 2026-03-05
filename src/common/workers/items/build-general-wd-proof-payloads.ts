import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  generateValidatorProof,
  generateWithdrawalProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  toWithdrawalStruct,
  verifyProof,
} from '../../helpers/proofs.js';
import type { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service.js';
import type { State } from '../../providers/consensus/consensus.js';
import { type SupportedBlock, getSsz } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkerLogger } from '../worker-logger.js';

export type BuildGeneralWithdrawalProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  currentBlock: SupportedBlock;
  withdrawals: InvolvedKeysWithWithdrawal;
  epoch: number;
};

async function buildGeneralWithdrawalsProofPayloads(): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
  const { currentHeader, nextHeaderTimestamp, state, currentBlock, withdrawals, epoch } =
    workerData as BuildGeneralWithdrawalProofArgs;
  //
  // Get views
  //
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);
  const currentBlockView = getSsz(state.forkName).BeaconBlock.toView(currentBlock);
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
    const validator = stateView.validators.getReadonly(Number(valIndex));
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
    const validatorProof = await generateValidatorProof(stateView, Number(valIndex));
    WorkerLogger.log('Generating withdrawal proof');
    const withdrawalProof = await generateWithdrawalProof(
      stateView,
      currentBlockView,
      keyWithWithdrawalInfo.withdrawal.offset,
    );
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    WorkerLogger.log('Verifying withdrawal proof locally');
    verifyProof(
      stateView.hashTreeRoot(),
      withdrawalProof.gindex,
      withdrawalProof.witnesses,
      currentBlockView.body.executionPayload.withdrawals
        .getReadonly(keyWithWithdrawalInfo.withdrawal.offset)
        .hashTreeRoot(),
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
      withdrawalBlock: {
        header: toBeaconHeaderStruct(currentHeader),
        rootsTimestamp: nextHeaderTimestamp,
      },
    });
  }
  return payloads;
}

buildGeneralWithdrawalsProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
