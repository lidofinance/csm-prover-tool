import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import { IVerifier } from '../../contracts/types/Verifier';
import { generateValidatorProof, generateWithdrawalProof, toHex, verifyProof } from '../../helpers/proofs';
import { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service';
import { State, SupportedBlock } from '../../providers/consensus/consensus';
import { BlockHeaderResponse } from '../../providers/consensus/response.interface';
import { WorkerLogger } from '../workers.service';

let ssz: typeof sszType;

export type BuildGeneralWithdrawalProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  currentBlock: SupportedBlock;
  withdrawals: InvolvedKeysWithWithdrawal;
  epoch: number;
};

async function buildGeneralWithdrawalsProofPayloads(): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { currentHeader, nextHeaderTimestamp, state, currentBlock, withdrawals, epoch } =
    workerData as BuildGeneralWithdrawalProofArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  // @ts-expect-error: thinks state can have different fork with currentBlock, but it's not possible
  const currentBlockView = ssz[state.forkName].BeaconBlock.toView(currentBlock);
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
        object: {
          index: Number(keyWithWithdrawalInfo.withdrawal.index),
          validatorIndex: Number(keyWithWithdrawalInfo.withdrawal.validatorIndex),
          withdrawalAddress: ssz.ExecutionAddress.toJson(keyWithWithdrawalInfo.withdrawal.address) as string,
          amount: BigInt(keyWithWithdrawalInfo.withdrawal.amount),
        },
        proof: withdrawalProof.witnesses.map(toHex),
      },
      validator: {
        index: Number(valIndex),
        nodeOperatorId: keyWithWithdrawalInfo.operatorId,
        keyIndex: keyWithWithdrawalInfo.keyIndex,
        object: {
          pubkey: keyWithWithdrawalInfo.pubKey,
          withdrawalCredentials: toHex(validator.withdrawalCredentials),
          effectiveBalance: BigInt(validator.effectiveBalance),
          slashed: Boolean(validator.slashed),
          activationEligibilityEpoch: BigInt(validator.activationEligibilityEpoch),
          activationEpoch: BigInt(validator.activationEpoch),
          exitEpoch: BigInt(validator.exitEpoch),
          withdrawableEpoch: BigInt(validator.withdrawableEpoch),
        },
        proof: validatorProof.witnesses.map(toHex),
      },
      withdrawalBlock: {
        header: {
          slot: Number(currentHeader.header.message.slot),
          proposerIndex: Number(currentHeader.header.message.proposer_index),
          parentRoot: currentHeader.header.message.parent_root,
          stateRoot: currentHeader.header.message.state_root,
          bodyRoot: currentHeader.header.message.body_root,
        },
        rootsTimestamp: nextHeaderTimestamp,
      },
    });
  }
  return payloads;
}

buildGeneralWithdrawalsProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
