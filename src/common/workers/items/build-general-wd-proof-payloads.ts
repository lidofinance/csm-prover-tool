import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  beaconHeaderRoot,
  generateBlockRootsProof,
  generateValidatorProof,
  generateWithdrawalProof,
  getWithdrawalView,
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
  withdrawalHeader: BlockHeaderResponse;
  recentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  withdrawalState: State;
  recentState: State;
  withdrawalBlock: SupportedBlock;
  withdrawals: InvolvedKeysWithWithdrawal;
  epoch: number;
};

async function buildGeneralWithdrawalsProofPayloads(): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
  const {
    withdrawalHeader,
    recentHeader,
    nextHeaderTimestamp,
    withdrawalState,
    recentState,
    withdrawalBlock,
    withdrawals,
    epoch,
  } = workerData as BuildGeneralWithdrawalProofArgs;
  //
  // Get views
  //
  const stateView = getSsz(withdrawalState.forkName).BeaconState.deserializeToView(withdrawalState.bodyBytes);
  const recentStateView = getSsz(recentState.forkName).BeaconState.deserializeToView(recentState.bodyBytes);
  const withdrawalBlockView = getSsz(withdrawalState.forkName).BeaconBlock.toView(withdrawalBlock);
  const blockRootsProof = await generateBlockRootsProof(recentStateView, Number(withdrawalHeader.header.message.slot));
  verifyProof(
    recentStateView.hashTreeRoot(),
    blockRootsProof.gindex,
    blockRootsProof.witnesses,
    beaconHeaderRoot(withdrawalHeader),
  );
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
    const validator = stateView.validators.get(Number(valIndex));
    if (toHex(validator.pubkey) != keyWithWithdrawalInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyWithWithdrawalInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }
    if (validator.slashed) {
      WorkerLogger.warn(
        `Validator ${valIndex} is slashed. Must be reported via reportSlashedWithdrawnValidators. Skipped`,
      );
      continue;
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
      withdrawalBlockView,
      keyWithWithdrawalInfo.withdrawal.offset,
      withdrawalState.forkName,
    );
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    WorkerLogger.log('Verifying withdrawal proof locally');
    verifyProof(
      stateView.hashTreeRoot(),
      withdrawalProof.gindex,
      withdrawalProof.witnesses,
      getWithdrawalView(
        stateView,
        withdrawalBlockView,
        keyWithWithdrawalInfo.withdrawal.offset,
        withdrawalState.forkName,
      ).hashTreeRoot(),
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
        header: toBeaconHeaderStruct(recentHeader),
        rootsTimestamp: nextHeaderTimestamp,
      },
      withdrawalBlock: {
        header: toBeaconHeaderStruct(withdrawalHeader),
        proof: blockRootsProof.witnesses.map(toHex),
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
