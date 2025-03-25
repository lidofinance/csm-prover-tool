import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

import { AccountingContract } from '../../contracts/accounting-contract.service';
import { CsmContract } from '../../contracts/csm-contract.service';
import { EjectorContract } from '../../contracts/ejector-contract.service';
import { ParametersRegistryContract } from '../../contracts/parameters-registry-contract.service';
import { StrikesContract } from '../../contracts/strikes-contract.service';
import { toHex } from '../../helpers/proofs';
import { Consensus, SupportedBlock } from '../../providers/consensus/consensus';
import { Execution } from '../../providers/execution/execution';
import { Ipfs } from '../../providers/ipfs/ipfs';
import { WorkersService } from '../../workers/workers.service';
import { FullKeyInfo, FullKeyInfoByPubKeyFn } from '../types';

export type InvolvedKeysWithBadPerformance = (FullKeyInfo & { strikesData: number[]; proof: string[] })[];

@Injectable()
export class BadPerformersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly execution: Execution,
    protected readonly ipfs: Ipfs,
    protected readonly csm: CsmContract,
    protected readonly strikes: StrikesContract,
    protected readonly ejector: EjectorContract,
    protected readonly accounting: AccountingContract,
    protected readonly params: ParametersRegistryContract,
  ) {}

  public isV2Initialized = false;

  public async getUnprovenNonExitedBadPerformers(
    blockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance> {
    //
    // TODO: Remove after Mainnet release. Needed only for v1 -> v2 smooth transition
    const csmVersion = await this.csm.getInitializedVersion();
    if (csmVersion == 1) return [];
    if (!this.isV2Initialized) await this.initV2();
    //
    const ejectableKeys = await this.getEligibleToEjectKeys(blockInfo, fullKeyInfoFn);
    if (Object.keys(ejectableKeys).length == 0) return [];
    const unproven: InvolvedKeysWithBadPerformance = [];
    for (const ejectableKey of ejectableKeys) {
      const proved = await this.ejector.isEjectionProved(ejectableKey);
      if (proved) {
        this.logger.warn(`Validator ${ejectableKey.validatorIndex} already proved as a bad performer`);
        continue;
      }
      unproven.push(ejectableKey);
    }
    if (unproven.length == 0) return [];
    const unprovenNonExited: InvolvedKeysWithBadPerformance = [];
    const state = await this.consensus.getState(toHex(blockInfo.stateRoot));
    const valExitEpochs: number[] = await this.workers.getValidatorExitEpochs({ state });
    for (const unprovenKey of unproven) {
      const valExitEpoch = valExitEpochs[unprovenKey.validatorIndex];
      if (valExitEpoch != Infinity) {
        this.logger.warn(`Validator ${unprovenKey.validatorIndex} already exited. No need to prove as a bad performer`);
        continue;
      }
      unprovenNonExited.push(unprovenKey);
    }
    this.logger.log(`🔍 Unproven non-exited bad performers: ${unprovenNonExited.length}`);
    return unprovenNonExited;
  }

  public async sendBadPerformanceProofs(badPerformers: InvolvedKeysWithBadPerformance): Promise<number> {
    if (Object.keys(badPerformers).length == 0) return 0;
    for (const badPerformer of badPerformers) {
      this.logger.log(`📡 Sending bad performer proof payload for validator index: ${badPerformer.validatorIndex}`);
      await this.strikes.sendBadPerformanceProof({ ...badPerformer, nodeOperatorId: badPerformer.operatorId });
    }
    return badPerformers.length;
  }

  private async getEligibleToEjectKeys(
    blockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance> {
    const eligibleToEjectKeys: InvolvedKeysWithBadPerformance = [];
    const blockHash = toHex(blockInfo.body.executionPayload.blockHash);

    const event = await this.strikes.findStrikesReportEventInBlock(blockHash);
    if (!event) return [];

    const treeData = await this.ipfs.get(event.treeCid);
    const tree = StandardMerkleTree.load<[number, string, number[]]>(treeData);
    if (tree.root != event.treeRoot) {
      throw new Error(`Unexpected Tree root from Tree CID ${event.treeCid}`);
    }

    for (const [i, leaf] of tree.entries()) {
      const [nodeOperatorId, pubKey, strikesData] = leaf;

      const strikesSum = strikesData.reduce((acc, val) => acc + val, 0);
      const threshold = await this.getStrikesThreshold(blockHash, nodeOperatorId);
      if (strikesSum < threshold) continue;

      const fullKeyInfo = fullKeyInfoFn(pubKey);
      if (!fullKeyInfo) continue;
      if (fullKeyInfo.operatorId != nodeOperatorId) {
        throw new Error(`Unexpected Node Operator ID (${fullKeyInfo.operatorId}) for ${pubKey} pubkey`);
      }

      eligibleToEjectKeys.push({
        ...fullKeyInfo,
        proof: tree.getProof(i),
        strikesData: strikesData,
      });
    }
    return eligibleToEjectKeys;
  }

  private async getStrikesThreshold(blockHash: string, nodeOperatorId: number): Promise<number> {
    const curveId = await this.accounting.getBondCurveId(blockHash, nodeOperatorId);
    const strikeParams = await this.params.getStrikeParams(blockHash, curveId);
    return strikeParams.threshold;
  }

  private async initV2() {
    this.logger.log('🆕 Initializing CSM v2');
    await Promise.all([this.params.init(), this.ejector.init(), this.strikes.init()]);
    this.isV2Initialized = true;
  }
}
