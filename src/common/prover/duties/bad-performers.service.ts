import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

import { ConfigService } from '../../config/config.service';
import { WorkingMode } from '../../config/env.validation';
import { AccountingContract } from '../../contracts/accounting-contract.service';
import { CsmContract } from '../../contracts/csm-contract.service';
import { ExitPenaltiesContract } from '../../contracts/exit-penalties-contract.service';
import { ParametersRegistryContract } from '../../contracts/parameters-registry-contract.service';
import { StrikesContract } from '../../contracts/strikes-contract.service';
import { ICSStrikes } from '../../contracts/types/Strikes';
import { toHex } from '../../helpers/proofs';
import { Consensus, SupportedBlock } from '../../providers/consensus/consensus';
import { Execution } from '../../providers/execution/execution';
import { Ipfs } from '../../providers/ipfs/ipfs';
import { WorkersService } from '../../workers/workers.service';
import { FullKeyInfo, FullKeyInfoByPubKeyFn } from '../types';

export type InvolvedKeysWithBadPerformance = (FullKeyInfo & { leafIndex: number; strikesData: number[] })[];

@Injectable()
export class BadPerformersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly execution: Execution,
    protected readonly ipfs: Ipfs,
    protected readonly csm: CsmContract,
    protected readonly strikes: StrikesContract,
    protected readonly exitPenalties: ExitPenaltiesContract,
    protected readonly accounting: AccountingContract,
    protected readonly params: ParametersRegistryContract,
  ) {}

  private isV2Initialized = false;
  private strikesTree: StandardMerkleTree<[number, string, number[]]> | undefined;

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
    //
    this.strikesTree = await this.getStrikesTree(blockInfo);
    if (!this.strikesTree) return [];
    const badPerfKeys = await this.getBadPerformersKeys(fullKeyInfoFn);
    if (!badPerfKeys) return [];
    const unproven = await this.getUnprovenKeys(badPerfKeys);
    if (!unproven) return [];
    const unprovenNonExited = await this.getNonExitedKeys(unproven);
    if (!unprovenNonExited) return [];
    return unprovenNonExited;
  }

  public async sendBadPerformanceProofs(badPerformers: InvolvedKeysWithBadPerformance): Promise<number> {
    if (badPerformers.length == 0) return 0;

    if (!this.strikesTree) {
      throw new Error('Strikes Tree should be initialized before sending bad performance proofs');
    }

    const keysMaxBatchSize = this.config.get('TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE');

    const batchCount = Math.ceil(badPerformers.length / keysMaxBatchSize);
    this.logger.log(
      `Preparing payloads for ${badPerformers.length} validators in ${batchCount} batches by ${keysMaxBatchSize} max keys each`,
    );

    badPerformers.sort((a, b) => b.leafIndex - a.leafIndex);
    for (let i = 0; i < badPerformers.length; i += keysMaxBatchSize) {
      const batch = badPerformers.slice(i, i + keysMaxBatchSize);

      const leavesIndices = batch.map((key) => key.leafIndex);
      const multiProof = this.strikesTree.getMultiProof(leavesIndices);

      // Build payloads by `multiProof.leaves` sorting
      const keyStrikesList: ICSStrikes.KeyStrikesStruct[] = multiProof.leaves.map((leaf) => {
        const [nodeOperatorId, pubKey, data] = leaf;
        const keyInfo = batch.find((key) => key.pubKey === pubKey);
        if (!keyInfo) {
          throw new Error(`Key info not found for pubkey ${pubKey} in the batch but it should be there`);
        }
        return {
          nodeOperatorId,
          keyIndex: keyInfo.keyIndex,
          data,
        };
      });

      const validatorIndices = batch.map((key) => key.validatorIndex).join(', ');
      this.logger.log(`📡 Sending bad performer multi-proof payload for batch of validators: ${validatorIndices}`);
      await this.strikes.sendBadPerformanceProof({
        keyStrikesList,
        proof: multiProof.proof,
        proofFlags: multiProof.proofFlags,
      });
    }
    return badPerformers.length;
  }

  private async getStrikesTree(
    blockInfo: SupportedBlock,
  ): Promise<StandardMerkleTree<[number, string, number[]]> | undefined> {
    const blockHash = toHex(blockInfo.body.executionPayload.blockHash);
    const event = await this.strikes.findStrikesReportEventInBlock(blockHash);
    if (!event) {
      this.logger.log(`No Strikes Report event found in block ${blockHash}`);
      return undefined;
    }

    const treeData = await this.ipfs.get(event.treeCid);
    const tree = StandardMerkleTree.load<[number, string, number[]]>(treeData);
    if (tree.root != event.treeRoot) {
      throw new Error(`Unexpected Tree root from Tree CID ${event.treeCid}`);
    }
    this.logger.log(`Strikes Tree loaded from IPFS: ${event.treeCid} with root ${tree.root}`);
    return tree;
  }

  private async getBadPerformersKeys(
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    if (!this.strikesTree) {
      throw new Error('Strikes Tree should be initialized');
    }
    const badPerfKeys: InvolvedKeysWithBadPerformance = [];

    for (const [i, leaf] of this.strikesTree.entries()) {
      const [nodeOperatorId, pubKey, strikesData] = leaf;

      const strikesSum = strikesData.reduce((acc, val) => acc + val, 0);
      const threshold = await this.getStrikesThreshold(nodeOperatorId);
      if (strikesSum < threshold) continue;

      const fullKeyInfo = fullKeyInfoFn(pubKey);

      if (!fullKeyInfo) {
        if (this.config.get('WORKING_MODE') == WorkingMode.CLI) {
          this.logger.warn(`No full key info found for pubkey ${pubKey} in the Strikes Tree`);
          continue;
        }
        throw new Error(`No full key info found for pubkey ${pubKey} in the Strikes Tree`);
      }

      if (fullKeyInfo.operatorId != nodeOperatorId) {
        throw new Error(`Unexpected Node Operator ID (${fullKeyInfo.operatorId}) for ${pubKey} pubkey`);
      }

      badPerfKeys.push({
        ...fullKeyInfo,
        leafIndex: i,
        strikesData: strikesData,
      });
    }
    if (Object.keys(badPerfKeys).length == 0) {
      this.logger.log('No bad performers in the Strikes Tree yet');
      return undefined;
    }
    this.logger.log(`🔍 Bad performers keys: ${badPerfKeys.length}`);
    return badPerfKeys;
  }

  private async getUnprovenKeys(
    ejectableKeys: InvolvedKeysWithBadPerformance,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    const unproven: InvolvedKeysWithBadPerformance = [];
    for (const ejectableKey of ejectableKeys) {
      const proved = await this.exitPenalties.isEjectionProved(ejectableKey);
      if (proved) {
        this.logger.warn(`Validator ${ejectableKey.validatorIndex} already proved as a bad performer`);
        continue;
      }
      unproven.push(ejectableKey);
    }
    if (unproven.length == 0) {
      this.logger.log('All eligible to ejection keys are already proved as bad performers');
      return undefined;
    }
    this.logger.log(`🔍 Unproven bad performers: ${unproven.length}`);
    return unproven;
  }

  private async getNonExitedKeys(
    unproven: InvolvedKeysWithBadPerformance,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    const unprovenNonExited: InvolvedKeysWithBadPerformance = [];
    const state = await this.consensus.getState('finalized');
    const valExitEpochs: number[] = await this.workers.getValidatorExitEpochs({ state });
    for (const unprovenKey of unproven) {
      const valExitEpoch = valExitEpochs[unprovenKey.validatorIndex];
      if (valExitEpoch != Infinity) {
        this.logger.warn(`Validator ${unprovenKey.validatorIndex} already exited. No need to prove as a bad performer`);
        continue;
      }
      unprovenNonExited.push(unprovenKey);
    }
    if (unprovenNonExited.length == 0) {
      this.logger.log('All unproven bad performers are already exited');
      return undefined;
    }
    this.logger.log(`🔍 Unproven non-exited bad performers: ${unprovenNonExited.length}`);
    return unprovenNonExited;
  }

  private async getStrikesThreshold(nodeOperatorId: number): Promise<number> {
    const curveId = await this.accounting.getBondCurveId('latest', nodeOperatorId);
    const strikeParams = await this.params.getStrikeParams('latest', curveId);
    return strikeParams.threshold;
  }

  private async initV2() {
    this.logger.log('🆕 Initializing CSM v2');
    await Promise.all([this.params.init(), this.strikes.init()]);
    // ExitPenalties can be initialized only after Strikes
    await this.exitPenalties.init();
    this.isV2Initialized = true;
  }
}
