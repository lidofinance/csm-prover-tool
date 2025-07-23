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
import { FullKeyInfo, FullKeyInfoByPubKeyFn } from '../types';

export type InvolvedKeysWithBadPerformance = (FullKeyInfo & { leafIndex: number; strikesData: number[] })[];

@Injectable()
export class BadPerformersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
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
  private currentStrikesTree: StandardMerkleTree<[number, string, number[]]> | undefined;
  private currentStrikesThresholdsByCurveId: Map<number, number> = new Map();
  private lastProcessedStrikesTreeRoot: string | undefined;

  public async getUnprovenNonWithdrawnBadPerformers(
    headBlockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance> {
    //
    // TODO: Remove after Mainnet release. Needed only for v1 -> v2 smooth transition
    const csmVersion = await this.csm.getInitializedVersion();
    if (csmVersion == 1) return [];
    if (!this.isV2Initialized) await this.initV2();
    //
    const strikesTree = await this.getStrikesTree(headBlockInfo);
    if (!strikesTree) return [];
    const thresholds = await this.getStrikesThresholds(headBlockInfo);
    if (this.isStrikesTreeAlreadyProcessed(strikesTree.root) && !this.isAnyStrikesThresholdChanged(thresholds)) {
      return [];
    }
    this.currentStrikesTree = strikesTree;
    this.currentStrikesThresholdsByCurveId = thresholds;
    const badPerfKeys = await this.getBadPerformersKeys(headBlockInfo, fullKeyInfoFn);
    if (!badPerfKeys) return [];
    const unproven = await this.getUnprovenKeys(headBlockInfo, badPerfKeys);
    if (!unproven) return [];
    const unprovenNonWithdrawn = await this.getNonWithdrawnKeys(headBlockInfo, unproven);
    if (!unprovenNonWithdrawn) return [];
    return unprovenNonWithdrawn;
  }

  public async sendBadPerformanceProofs(badPerformers: InvolvedKeysWithBadPerformance): Promise<number> {
    if (!Object.keys(badPerformers).length) return 0;

    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized before sending bad performance proofs');
    }

    const keysMaxBatchSize = this.config.get('TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE');

    const batchCount = Math.ceil(badPerformers.length / keysMaxBatchSize);

    this.logger.log(
      `Preparing payloads for ${badPerformers.length} validators in ${batchCount} batches by ${keysMaxBatchSize} max keys each`,
    );

    badPerformers.sort((a, b) => b.leafIndex - a.leafIndex);

    await this.processBadPerformerBatches(badPerformers, keysMaxBatchSize);

    this.lastProcessedStrikesTreeRoot = this.currentStrikesTree.root;
    return badPerformers.length;
  }

  private async processBadPerformerBatches(
    badPerformers: InvolvedKeysWithBadPerformance,
    keysMaxBatchSize: number,
  ): Promise<void> {
    for (let i = 0; i < badPerformers.length; i += keysMaxBatchSize) {
      const batch = badPerformers.slice(i, i + keysMaxBatchSize);
      await this.processBatch(batch);
    }
  }

  private async processBatch(batch: InvolvedKeysWithBadPerformance): Promise<void> {
    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized before processing batches');
    }

    const leavesIndices = batch.map((key) => key.leafIndex);
    const multiProof = this.currentStrikesTree.getMultiProof(leavesIndices);
    const keyStrikesList = this.buildKeyStrikesPayload(multiProof.leaves, batch);

    const validatorIndices = batch.map((key) => key.validatorIndex).join(', ');
    this.logger.log(`📡 Sending bad performer multi-proof payload for batch of validators: ${validatorIndices}`);

    await this.strikes.sendBadPerformanceProof({
      keyStrikesList,
      proof: multiProof.proof,
      proofFlags: multiProof.proofFlags,
    });
  }

  private buildKeyStrikesPayload(
    leaves: [number, string, number[]][],
    batch: InvolvedKeysWithBadPerformance,
  ): ICSStrikes.KeyStrikesStruct[] {
    return leaves.map((leaf) => {
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
  }

  private async getStrikesTree(
    headBlockInfo: SupportedBlock,
  ): Promise<StandardMerkleTree<[number, string, number[]]> | undefined> {
    const latestBlockHash = toHex(headBlockInfo.body.executionPayload.blockHash);
    const treeRoot = await this.strikes.getTreeRoot(latestBlockHash);
    const treeCid = await this.strikes.getTreeCid(latestBlockHash);
    if (!treeCid || treeCid == '0x') {
      this.logger.log('No Strikes Tree CID found in latest block');
      return undefined;
    }

    if (this.currentStrikesTree && this.currentStrikesTree.root == treeRoot) {
      this.logger.log(`Strikes Tree already loaded with root ${this.currentStrikesTree.root}`);
      return this.currentStrikesTree;
    }

    const treeData = await this.ipfs.get(treeCid);
    const tree = StandardMerkleTree.load<[number, string, number[]]>(treeData);
    if (tree.root != treeRoot) {
      throw new Error(`Unexpected Tree root from Tree CID ${treeCid}`);
    }
    this.logger.log(`🌲 Strikes Tree loaded from IPFS: ${treeCid} with root ${tree.root}`);
    return tree;
  }

  private isStrikesTreeAlreadyProcessed(strikesTreeRoot: string): boolean {
    const isRootAlreadyProcessed = this.lastProcessedStrikesTreeRoot == strikesTreeRoot;
    if (isRootAlreadyProcessed) {
      this.logger.log('Strikes Tree already processed. No need to process again');
      return true;
    }
    return false;
  }

  private isAnyStrikesThresholdChanged(thresholds: Map<number, number>): boolean {
    for (const [curveId, threshold] of thresholds.entries()) {
      const currentThreshold = this.currentStrikesThresholdsByCurveId.get(curveId);
      if (currentThreshold !== threshold) {
        this.logger.log(`Strikes threshold for curve ID ${curveId} changed from ${currentThreshold} to ${threshold}`);
        return true;
      }
    }
    this.logger.log('No strikes thresholds changed since last processing');
    return false;
  }

  private async getBadPerformersKeys(
    headBlockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized');
    }
    const latestBlockHash = toHex(headBlockInfo.body.executionPayload.blockHash);
    const badPerfKeys: InvolvedKeysWithBadPerformance = [];

    this.logger.log(`All keys in the Strikes Tree: ${this.currentStrikesTree.length}`);

    this.logger.log('🔍 Searching for keys above the strikes threshold in the Strikes Tree');

    for (const [i, leaf] of this.currentStrikesTree.entries()) {
      const [nodeOperatorId, pubKey, strikesData] = leaf;

      const strikesSum = strikesData.reduce((acc, val) => acc + val, 0);
      const threshold = await this.getStrikesThresholdByNodeOperatorId(latestBlockHash, nodeOperatorId);
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
      this.logger.log('No keys found with strikes above the threshold');
      return undefined;
    }
    this.logger.log(`🔍 Keys with strikes above the threshold: ${badPerfKeys.length}`);
    return badPerfKeys;
  }

  private async getUnprovenKeys(
    headBlockInfo: SupportedBlock,
    keys: InvolvedKeysWithBadPerformance,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    const latestBlockHash = toHex(headBlockInfo.body.executionPayload.blockHash);
    const unproven: InvolvedKeysWithBadPerformance = [];

    this.logger.log('🔍 Searching for unproven bad performers');

    for (const key of keys) {
      const proved = await this.exitPenalties.isEjectionProved(latestBlockHash, key);
      if (proved) {
        this.logger.warn(`Validator ${key.validatorIndex} already proven as a bad performer`);
        continue;
      }
      unproven.push(key);
    }
    if (unproven.length == 0) {
      this.logger.log('All keys are already proven as bad performers');
      return undefined;
    }
    this.logger.log(`🔍 Unproven bad performers: ${unproven.length}`);
    return unproven;
  }

  private async getNonWithdrawnKeys(
    headBlockInfo: SupportedBlock,
    keys: InvolvedKeysWithBadPerformance,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    const latestBlockHash = toHex(headBlockInfo.body.executionPayload.blockHash);
    const nonWithdrawn: InvolvedKeysWithBadPerformance = [];

    this.logger.log('🔍 Searching for non-withdrawn bad performers');

    for (const key of keys) {
      const withdrawalProved = await this.csm.isWithdrawalProved(latestBlockHash, key);
      if (withdrawalProved) {
        this.logger.warn(
          `Validator ${key.validatorIndex} already reported as withdrawn. No need to prove as a bad performer`,
        );
        continue;
      }
      nonWithdrawn.push(key);
    }
    if (nonWithdrawn.length == 0) {
      this.logger.log('All bad performers are already reported as withdrawn');
      return undefined;
    }
    this.logger.log(`🔍 Non-withdrawn bad performers: ${nonWithdrawn.length}`);
    return nonWithdrawn;
  }

  private async getStrikesThresholds(headBlockInfo: SupportedBlock): Promise<Map<number, number>> {
    const latestBlockHash = toHex(headBlockInfo.body.executionPayload.blockHash);
    const thresholds = new Map<number, number>();

    const curvesCount = await this.accounting.getCurvesCount(latestBlockHash);
    for (let curveId = 0; curveId < curvesCount; curveId++) {
      const params = await this.params.getStrikeParams(latestBlockHash, curveId);
      thresholds.set(curveId, params.threshold);
    }
    return thresholds;
  }

  private async getStrikesThresholdByNodeOperatorId(blockHash: string, nodeOperatorId: number): Promise<number> {
    const curveId = await this.accounting.getBondCurveId(blockHash, nodeOperatorId);
    const threshold = this.currentStrikesThresholdsByCurveId.get(curveId);
    if (threshold === undefined) {
      throw new Error(
        `Strikes threshold for Node Operator ID ${nodeOperatorId} (Curve ID ${curveId}) not found in the cache`,
      );
    }
    return threshold;
  }

  private async initV2() {
    this.logger.log('🆕 Initializing CSM v2');
    await Promise.all([this.params.init(), this.strikes.init()]);
    // ExitPenalties can be initialized only after Strikes
    await this.exitPenalties.init();
    this.isV2Initialized = true;
  }
}
