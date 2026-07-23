import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  generateValidatorProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  verifyProof,
} from '../../helpers/proofs.js';
import type { InvolvedKeys } from '../../prover/duties/slashings.service.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getSsz } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkerLogger } from '../worker-logger.js';

export type BuildSlashingProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  slashings: InvolvedKeys;
};

async function buildSlashingProofPayloads(): Promise<IVerifier.ProcessSlashedInputStruct[]> {
  const { currentHeader, nextHeaderTimestamp, state, slashings } = workerData as BuildSlashingProofArgs;
  //
  // Get views
  //
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);
  //
  //
  //
  const payloads = [];
  for (const [valIndex, keyInfo] of Object.entries(slashings)) {
    const validator = stateView.validators.get(Number(valIndex));
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
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
