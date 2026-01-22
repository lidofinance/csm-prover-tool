import { parentPort, workerData } from 'node:worker_threads';

import type { ssz as sszType } from '@lodestar/types';

import { IVerifier } from '../../contracts/types/Verifier';
import {
  generateValidatorProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  verifyProof,
} from '../../helpers/proofs';
import { InvolvedKeys } from '../../prover/duties/slashings.service';
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

async function buildSlashingProofPayloads(): Promise<IVerifier.ProcessSlashedInputStruct[]> {
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
    const validatorProof = await generateValidatorProof(stateView, Number(valIndex));
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    payloads.push({
      validator: {
        index: Number(valIndex),
        nodeOperatorId: keyInfo.operatorId,
        keyIndex: keyInfo.keyIndex,
        object: toValidatorStruct(validator),
        proof: validatorProof.witnesses.map(toHex),
      },
      recentBlock: {
        header: toBeaconHeaderStruct(currentHeader),
        rootsTimestamp: nextHeaderTimestamp,
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
