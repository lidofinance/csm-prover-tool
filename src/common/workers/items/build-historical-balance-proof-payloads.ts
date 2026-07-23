import { parentPort, workerData } from 'node:worker_threads';

import type { IVerifier } from '../../contracts/types/Verifier.js';
import {
  generateBalanceProof,
  generateHistoricalStateProof,
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

export type BuildHistoricalBalanceProofArgs = {
  headerWithBalances: BlockHeaderResponse;
  recentHeader: BlockHeaderResponse;
  nextToRecentHeaderTimestamp: number;
  stateWithBalances: State;
  recentState: State;
  summaryState: State;
  summaryIndex: number;
  rootIndexInSummary: number;
  keys: InvolvedKeys;
};

async function buildHistoricalBalanceProofPayloads(): Promise<IVerifier.ProcessHistoricalBalanceProofInputStruct[]> {
  const {
    headerWithBalances,
    recentHeader,
    nextToRecentHeaderTimestamp,
    stateWithBalances,
    recentState,
    summaryState,
    summaryIndex,
    rootIndexInSummary,
    keys,
  } = workerData as BuildHistoricalBalanceProofArgs;

  const stateWithBalancesView = getSsz(stateWithBalances.forkName).BeaconState.deserializeToView(
    stateWithBalances.bodyBytes,
  );
  const recentStateView = getSsz(recentState.forkName).BeaconState.deserializeToView(recentState.bodyBytes);
  const summaryStateView = getSsz(summaryState.forkName).BeaconState.deserializeToView(summaryState.bodyBytes);

  WorkerLogger.log('Generating historical state proof');
  const historicalStateProof = await generateHistoricalStateProof(
    recentStateView,
    summaryStateView,
    summaryIndex,
    rootIndexInSummary,
  );
  WorkerLogger.log('Verifying historical state proof locally');
  verifyProof(
    recentStateView.hashTreeRoot(),
    historicalStateProof.gindex,
    historicalStateProof.witnesses,
    summaryStateView.blockRoots.getReadonly(rootIndexInSummary),
  );

  const payloads: IVerifier.ProcessHistoricalBalanceProofInputStruct[] = [];
  for (const [valIndex, keyInfo] of Object.entries(keys)) {
    const valIndexNum = Number(valIndex);
    const validator = stateWithBalancesView.validators.get(valIndexNum);
    if (toHex(validator.pubkey) !== keyInfo.pubKey) {
      WorkerLogger.error(
        `Validator ${valIndex} pubkey mismatch with key from the contract 
        Key from the state ${toHex(validator.pubkey)}
        Key from the contract ${keyInfo.pubKey}`,
      );
      throw new Error('Validator pubkey mismatch');
    }

    WorkerLogger.log(`Generating validator [${valIndex}] proof`);
    const validatorProof = await generateValidatorProof(stateWithBalancesView, valIndexNum);
    WorkerLogger.log('Generating balance proof');
    const balanceProof = await generateBalanceProof(stateWithBalancesView, valIndexNum);
    WorkerLogger.log('Verifying validator proof locally');
    verifyProof(
      stateWithBalancesView.hashTreeRoot(),
      validatorProof.gindex,
      validatorProof.witnesses,
      validator.hashTreeRoot(),
    );
    WorkerLogger.log('Verifying balance proof locally');
    verifyProof(stateWithBalancesView.hashTreeRoot(), balanceProof.gindex, balanceProof.witnesses, balanceProof.leaf);

    payloads.push({
      recentBlock: {
        header: toBeaconHeaderStruct(recentHeader),
        rootsTimestamp: nextToRecentHeaderTimestamp,
      },
      historicalBlock: {
        header: toBeaconHeaderStruct(headerWithBalances),
        proof: historicalStateProof.witnesses.map(toHex),
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

buildHistoricalBalanceProofPayloads()
  .then((v) => parentPort?.postMessage(v))
  .catch((e) => {
    WorkerLogger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  });
