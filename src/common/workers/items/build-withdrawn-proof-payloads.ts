import { parentPort, workerData } from 'node:worker_threads';

import type { ICuratedVerifier } from '../../contracts/types/CuratedVerifier.js';
import {
  generateValidatorProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  verifyProof,
} from '../../helpers/proofs.js';
import type { InvolvedKeys } from '../../prover/duties/withdrawn.service.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getSsz } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkerLogger } from '../worker-logger.js';

export type BuildWithdrawnProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  keys: InvolvedKeys;
  epoch: number;
};

async function buildWithdrawnProofPayloads(): Promise<ICuratedVerifier.ProcessWithdrawnInputStruct[]> {
  const { currentHeader, nextHeaderTimestamp, state, keys, epoch } = workerData as BuildWithdrawnProofArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const payloads: ICuratedVerifier.ProcessWithdrawnInputStruct[] = [];
  for (const [valIndex, keyInfo] of Object.entries(keys)) {
    const valIndexNum = Number(valIndex);
    const validator = stateView.validators.getReadonly(valIndexNum);
    if (toHex(validator.pubkey) !== keyInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }
    if (validator.slashed) {
      WorkerLogger.warn(`Validator ${valIndex} is slashed in the finalized state. Skipped`);
      continue;
    }
    if (epoch < validator.withdrawableEpoch) {
      WorkerLogger.warn(
        `Validator ${valIndex} is withdrawable since epoch ${validator.withdrawableEpoch} (finalized state epoch ${epoch}). Skipped`,
      );
      continue;
    }

    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = await generateValidatorProof(stateView, valIndexNum);
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    payloads.push({
      validator: {
        index: valIndexNum,
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

buildWithdrawnProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
