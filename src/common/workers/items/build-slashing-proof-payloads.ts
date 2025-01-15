import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import { generateValidatorProof, toHex, verifyProof } from '../../helpers/proofs';
import { InvolvedKeys } from '../../prover/duties/slashings.service';
import { SlashingProofPayload } from '../../prover/types';
import { State } from '../../providers/consensus/consensus';
import { BlockHeaderResponse } from '../../providers/consensus/response.interface';
import { WorkerLogger } from '../workers.service';

let ssz: typeof sszType;

export type BuildSlashingProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  slashings: InvolvedKeys;
};

async function buildSlashingProofPayloads(): Promise<SlashingProofPayload[]> {
  ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
  const { currentHeader, nextHeaderTimestamp, state, slashings } = workerData as BuildSlashingProofArgs;
  //
  // Get views
  //
  const stateView = ssz[state.forkName].BeaconState.deserializeToView(state.bodyBytes);
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyInfo] of Object.entries(slashings)) {
    const validator = stateView.validators.getReadonly(Number(valIndex));
    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = generateValidatorProof(stateView, Number(valIndex));
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    payloads.push({
      keyIndex: keyInfo.keyIndex,
      nodeOperatorId: keyInfo.operatorId,
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
        validatorIndex: Number(valIndex),
        withdrawalCredentials: toHex(validator.withdrawalCredentials),
        effectiveBalance: validator.effectiveBalance,
        activationEligibilityEpoch: validator.activationEligibilityEpoch,
        activationEpoch: validator.activationEpoch,
        exitEpoch: validator.exitEpoch,
        withdrawableEpoch: validator.withdrawableEpoch,
        validatorProof: validatorProof.witnesses.map(toHex),
      },
    });
  }
  return payloads;
}

buildSlashingProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    console.error(e);
    throw e;
  });
