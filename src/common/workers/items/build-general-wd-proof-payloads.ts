import { parentPort, workerData } from 'node:worker_threads';

import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';

import { generateValidatorProof, generateWithdrawalProof, toHex, verifyProof } from '../../helpers/proofs';
import { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service';
import { WithdrawalsProofPayload } from '../../prover/types';
import { State } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, BlockInfoResponse } from '../../providers/consensus/response.interface';
import { WorkerLogger } from '../workers.service';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;
let ForkName: typeof import('@lodestar/params').ForkName;

export type BuildGeneralWithdrawalProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  currentBlock: BlockInfoResponse;
  withdrawals: InvolvedKeysWithWithdrawal;
  epoch: number;
};

async function buildGeneralWithdrawalsProofPayloads(): Promise<WithdrawalsProofPayload[]> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { currentHeader, nextHeaderTimestamp, state, currentBlock, withdrawals, epoch } =
    workerData as BuildGeneralWithdrawalProofArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName as keyof typeof ForkName].BeaconState.deserializeToView(
    state.bodyBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;
  const currentBlockView = ssz[state.forkName as keyof typeof ForkName].BeaconBlock.toView(
    ssz[state.forkName as keyof typeof ForkName].BeaconBlock.fromJson(currentBlock.message) as any,
  ) as ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>;
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
    const validator = stateView.validators.getReadonly(Number(valIndex));
    if (epoch < validator.withdrawableEpoch) {
      WorkerLogger.warn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
      continue;
    }
    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = generateValidatorProof(stateView, Number(valIndex));
    WorkerLogger.log('Generating withdrawal proof');
    const withdrawalProof = generateWithdrawalProof(
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
      (
        currentBlockView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
      ).body.executionPayload.withdrawals
        .getReadonly(keyWithWithdrawalInfo.withdrawal.offset)
        .hashTreeRoot(),
    );
    payloads.push({
      keyIndex: keyWithWithdrawalInfo.keyIndex,
      nodeOperatorId: keyWithWithdrawalInfo.operatorId,
      beaconBlock: {
        header: {
          slot: currentHeader.header.message.slot,
          proposerIndex: Number(currentHeader.header.message.proposer_index),
          parentRoot: currentHeader.header.message.parent_root,
          stateRoot: currentHeader.header.message.state_root,
          bodyRoot: currentHeader.header.message.body_root,
        },
        rootsTimestamp: nextHeaderTimestamp,
      },
      witness: {
        withdrawalOffset: Number(keyWithWithdrawalInfo.withdrawal.offset),
        withdrawalIndex: Number(keyWithWithdrawalInfo.withdrawal.index),
        validatorIndex: Number(keyWithWithdrawalInfo.withdrawal.validator_index),
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

buildGeneralWithdrawalsProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
