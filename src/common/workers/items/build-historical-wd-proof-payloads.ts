import { parentPort, workerData } from 'node:worker_threads';

import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';

import {
  generateHistoricalStateProof,
  generateValidatorProof,
  generateWithdrawalProof,
  toHex,
  verifyProof,
} from '../../helpers/proofs';
import { InvolvedKeysWithWithdrawal } from '../../prover/duties/withdrawals.service';
import { State } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, BlockInfoResponse } from '../../providers/consensus/response.interface';
import { parentLog, parentWarn } from '../workers.service';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;
let ForkName: typeof import('@lodestar/params').ForkName;

async function buildHistoricalWithdrawalsProofPayloads(): Promise<void> {
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
  } = workerData as {
    headerWithWds: BlockHeaderResponse;
    finalHeader: BlockHeaderResponse;
    nextToFinalizedHeaderTimestamp: number;
    finalizedState: State;
    summaryState: State;
    stateWithWds: State;
    blockWithWds: BlockInfoResponse;
    summaryIndex: number;
    rootIndexInSummary: number;
    withdrawals: InvolvedKeysWithWithdrawal;
    epoch: number;
  };
  //
  // Get views
  //
  const finalizedStateView = ssz[finalizedState.forkName as keyof typeof ForkName].BeaconState.deserializeToView(
    finalizedState.bodyBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;
  const summaryStateView = ssz[summaryState.forkName as keyof typeof ForkName].BeaconState.deserializeToView(
    summaryState.bodyBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;
  const stateWithWdsView = ssz[stateWithWds.forkName as keyof typeof ForkName].BeaconState.deserializeToView(
    stateWithWds.bodyBytes,
  ) as ContainerTreeViewType<typeof anySsz.BeaconState.fields>;
  const blockWithWdsView = ssz[stateWithWds.forkName as keyof typeof ForkName].BeaconBlock.toView(
    ssz[stateWithWds.forkName as keyof typeof ForkName].BeaconBlock.fromJson(blockWithWds.message) as any,
  ) as ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>;
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
    const validator = stateWithWdsView.validators.getReadonly(Number(valIndex));
    if (epoch < validator.withdrawableEpoch) {
      parentWarn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
      continue;
    }
    parentLog(`Generating validator [${valIndex}] proof`);
    const validatorProof = generateValidatorProof(stateWithWdsView, Number(valIndex));
    parentLog('Generating withdrawal proof');
    const withdrawalProof = generateWithdrawalProof(
      stateWithWdsView,
      blockWithWdsView,
      keyWithWithdrawalInfo.withdrawal.offset,
    );
    parentLog('Generating historical state proof');
    const historicalStateProof = generateHistoricalStateProof(
      finalizedStateView,
      summaryStateView,
      summaryIndex,
      rootIndexInSummary,
    );
    parentLog('Verifying validator proof locally');
    verifyProof(
      stateWithWdsView.hashTreeRoot(),
      validatorProof.gindex,
      validatorProof.witnesses,
      validator.hashTreeRoot(),
    );
    parentLog('Verifying withdrawal proof locally');
    verifyProof(
      stateWithWdsView.hashTreeRoot(),
      withdrawalProof.gindex,
      withdrawalProof.witnesses,
      (
        blockWithWdsView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
      ).body.executionPayload.withdrawals
        .getReadonly(keyWithWithdrawalInfo.withdrawal.offset)
        .hashTreeRoot(),
    );
    parentLog('Verifying historical state proof locally');
    verifyProof(
      finalizedStateView.hashTreeRoot(),
      historicalStateProof.gindex,
      historicalStateProof.witnesses,
      (summaryStateView as ContainerTreeViewType<typeof ssz.capella.BeaconState.fields>).blockRoots.getReadonly(
        rootIndexInSummary,
      ),
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
  parentPort?.postMessage(payloads);
}

buildHistoricalWithdrawalsProofPayloads().catch((e) => {
  console.error(e);
  throw e;
});
