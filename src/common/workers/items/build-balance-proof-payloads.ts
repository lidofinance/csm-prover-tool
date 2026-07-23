import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  generateBalanceProof,
  generateValidatorProof,
  toBeaconHeaderStruct,
  toHex,
  toValidatorStruct,
  verifyProof,
} from '../../helpers/proofs.js';
import type { InvolvedKeys } from '../../prover/duties/balances.service.js';
import type { State } from '../../providers/consensus/consensus.js';
import { getSsz } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkerLogger } from '../worker-logger.js';

export type BuildBalanceProofArgs = {
  currentHeader: BlockHeaderResponse;
  nextHeaderTimestamp: number;
  state: State;
  keys: InvolvedKeys;
};

async function buildBalanceProofPayloads(): Promise<IVerifier.ProcessBalanceProofInputStruct[]> {
  const { currentHeader, nextHeaderTimestamp, state, keys } = workerData as BuildBalanceProofArgs;
  const stateView = getSsz(state.forkName).BeaconState.deserializeToView(state.bodyBytes);

  const payloads: IVerifier.ProcessBalanceProofInputStruct[] = [];
  for (const [valIndex, keyInfo] of Object.entries(keys)) {
    const valIndexNum = Number(valIndex);
    const validator = stateView.validators.get(valIndexNum);
    if (toHex(validator.pubkey) !== keyInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }

    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = await generateValidatorProof(stateView, valIndexNum);
    WorkerLogger.log('Generating balance proof');
    const balanceProof = await generateBalanceProof(stateView, valIndexNum);
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
    WorkerLogger.log('Verifying balance proof locally');
    verifyProof(stateView.hashTreeRoot(), balanceProof.gindex, balanceProof.witnesses, balanceProof.leaf);

    payloads.push({
      recentBlock: {
        header: toBeaconHeaderStruct(currentHeader),
        rootsTimestamp: nextHeaderTimestamp,
      },
      validator: {
        index: valIndexNum,
        nodeOperatorId: keyInfo.operatorId,
        keyIndex: keyInfo.keyIndex,
        object: toValidatorStruct(validator),
        proof: validatorProof.witnesses.map(toHex),
      },
      balance: {
        node: toHex(balanceProof.leaf),
        proof: balanceProof.witnesses.map(toHex),
      },
    });
  }

  return payloads;
}

buildBalanceProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
