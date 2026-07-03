import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

import { ConfigService } from '../../config/config.service.js';
import { WorkingMode } from '../../config/env.validation.js';
import { AccountingContract } from '../../contracts/accounting-contract.service.js';
import { ExitPenaltiesContract } from '../../contracts/exit-penalties-contract.service.js';
import { ParametersRegistryContract } from '../../contracts/parameters-registry-contract.service.js';
import { StakingModuleContract } from '../../contracts/staking-module-contract.service.js';
import { StrikesContract } from '../../contracts/strikes-contract.service.js';
import type { IValidatorStrikes } from '../../contracts/types/Strikes.js';
import { toBlockTagByHash } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus } from '../../providers/consensus/consensus.js';
import type { SupportedBlock } from '../../providers/consensus/forks.js';
import { Ipfs } from '../../providers/ipfs/ipfs.js';
import type { FullKeyInfo, FullKeyInfoByPubKeyFn } from '../types.js';

export type InvolvedKeysWithBadPerformance = (FullKeyInfo & { leafIndex: number; strikesData: number[] })[];

type StrikesTreeLeaf = [number, string, number[]]; // [nodeOperatorId, pubKey, strikesData]

@Injectable()
export class BadPerformersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly ipfs: Ipfs,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly strikes: StrikesContract,
    protected readonly exitPenalties: ExitPenaltiesContract,
    protected readonly accounting: AccountingContract,
    protected readonly params: ParametersRegistryContract,
  ) {}

  private currentStrikesTree: StandardMerkleTree<StrikesTreeLeaf> | undefined;
  private currentStrikesThresholdsByCurveId: Map<number, number> = new Map();
  private currentNodeOperatorsCurveIds: Map<number, number> = new Map();
  private lastProcessedStrikesTreeRoot: string | undefined;

  public getCurrentExitRequestsLimit(): Promise<bigint> {
    return this.strikes.getCurrentExitRequestsLimit();
  }

  public async getUnprovenNonWithdrawnBadPerformers(
    headBlockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance> {
    const isAnyToProcess = await this.prepareStrikesTreeForProcessing(headBlockInfo);
    if (!isAnyToProcess) return [];
    const badPerfKeys = await this.getBadPerformersKeys(fullKeyInfoFn);
    if (!badPerfKeys) return [];
    const unproven = await this.getUnprovenKeys(headBlockInfo, badPerfKeys);
    if (!unproven) return [];
    const unprovenNonWithdrawn = await this.getNonWithdrawnKeys(unproven);
    if (!unprovenNonWithdrawn) return [];
    return unprovenNonWithdrawn;
  }

  public async sendBadPerformanceProofs(badPerformers: InvolvedKeysWithBadPerformance): Promise<number> {
    if (badPerformers.length == 0) {
      if (this.currentStrikesTree) {
        this.lastProcessedStrikesTreeRoot = this.currentStrikesTree.root;
      }
      return 0;
    }
    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized before sending bad performance proofs');
    }

    const keysMaxBatchSize = this.config.get('TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE');

    // Each key triggers one exit request; cap the report to what the gateway allows now and defer the rest.
    const exitLimit = await this.strikes.getCurrentExitRequestsLimit();
    const sendAll = exitLimit >= BigInt(badPerformers.length);
    const toSend = sendAll ? badPerformers : badPerformers.slice(0, Number(exitLimit));
    if (!sendAll) {
      this.logger.warn(
        `⚠️ Exit request limit ${exitLimit} < ${badPerformers.length} bad performers; sending ${toSend.length} now, deferring the rest`,
      );
    }
    if (toSend.length === 0) return 0; // nothing allowed now — leave the tree unprocessed and retry next round

    const batchCount = Math.ceil(toSend.length / keysMaxBatchSize);

    this.logger.log(
      `Preparing payloads for ${toSend.length} validators in ${batchCount} batches by ${keysMaxBatchSize} max keys each`,
    );

    await this.processBadPerformerBatches(toSend, keysMaxBatchSize);

    // Mark the tree processed only if the full set was sent; a partial send is retried next round.
    if (sendAll) {
      this.lastProcessedStrikesTreeRoot = this.currentStrikesTree.root;
    }
    return toSend.length;
  }

  private async prepareStrikesTreeForProcessing(headBlockInfo: SupportedBlock): Promise<boolean> {
    const strikesTree = await this.getStrikesTree(headBlockInfo);
    if (!strikesTree) return false;
    const thresholds = await this.getStrikesThresholds(headBlockInfo);
    const curveIds = await this.getNodeOperatorsCurveIds(strikesTree, headBlockInfo);
    if (
      this.isStrikesTreeAlreadyProcessed(strikesTree.root) &&
      !this.isAnyStrikesThresholdChanged(thresholds) &&
      !this.isAnyNodeOperatorCurveIdChanged(curveIds)
    ) {
      return false;
    }
    this.currentStrikesTree = strikesTree;
    this.currentStrikesThresholdsByCurveId = thresholds;
    this.currentNodeOperatorsCurveIds = curveIds;
    return true;
  }

  private async processBadPerformerBatches(
    badPerformers: InvolvedKeysWithBadPerformance,
    keysMaxBatchSize: number,
  ): Promise<void> {
    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized before processing batches');
    }
    badPerformers.sort((a, b) => b.leafIndex - a.leafIndex);
    for (let i = 0; i < badPerformers.length; i += keysMaxBatchSize) {
      const batch = badPerformers.slice(i, i + keysMaxBatchSize);
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
  }

  private buildKeyStrikesPayload(
    leaves: StrikesTreeLeaf[],
    batch: InvolvedKeysWithBadPerformance,
  ): IValidatorStrikes.KeyStrikesStruct[] {
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
  ): Promise<StandardMerkleTree<StrikesTreeLeaf> | undefined> {
    const blockTag = toBlockTagByHash(headBlockInfo.body.executionPayload.blockHash);
    const treeRoot = await this.strikes.getTreeRoot(blockTag);
    const treeCid = await this.strikes.getTreeCid(blockTag);
    if (!treeCid || treeCid == '0x') {
      this.logger.log('No Strikes Tree CID found in latest block');
      return undefined;
    }

    if (this.currentStrikesTree && this.currentStrikesTree.root == treeRoot) {
      this.logger.log(`Strikes Tree already loaded with root ${this.currentStrikesTree.root}`);
      return this.currentStrikesTree;
    }

    const treeData = await this.ipfs.get(treeCid);
    const tree = StandardMerkleTree.load<StrikesTreeLeaf>(treeData);
    if (tree.root != treeRoot) {
      throw new Error(`Unexpected Tree root from Tree CID ${treeCid}`);
    }
    this.logger.log(`🌲 Strikes Tree loaded from IPFS: ${treeCid} with root ${tree.root}`);
    return tree;
  }

  private isStrikesTreeAlreadyProcessed(strikesTreeRoot: string): boolean {
    const isRootAlreadyProcessed = this.lastProcessedStrikesTreeRoot == strikesTreeRoot;
    if (isRootAlreadyProcessed) {
      this.logger.log('Strikes Tree already processed');
      return true;
    }
    return false;
  }

  private isAnyNodeOperatorCurveIdChanged(curveIds: Map<number, number>): boolean {
    for (const [nodeOperatorId, curveId] of curveIds.entries()) {
      const currentCurveId = this.currentNodeOperatorsCurveIds.get(nodeOperatorId);
      if (currentCurveId !== curveId) {
        this.logger.log(
          `Node Operator ${nodeOperatorId} get changed from Curve ID from ${currentCurveId} to ${curveId}`,
        );
        return true;
      }
    }
    this.logger.log('No node operator curve ids changes since last processing');
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
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    if (!this.currentStrikesTree) {
      throw new Error('Strikes Tree should be initialized');
    }
    const badPerfKeys: InvolvedKeysWithBadPerformance = [];

    this.logger.log(`All keys in the Strikes Tree: ${this.currentStrikesTree.length}`);

    this.logger.log('🔍 Searching for keys above the strikes threshold in the Strikes Tree');

    for (const [i, leaf] of this.currentStrikesTree.entries()) {
      const [nodeOperatorId, pubKey, strikesData] = leaf;

      const strikesSum = strikesData.reduce((acc, val) => acc + val, 0);
      const threshold = await this.getStrikesThresholdByNodeOperatorId(nodeOperatorId);
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
    if (badPerfKeys.length == 0) {
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
    const blockTag = toBlockTagByHash(headBlockInfo.body.executionPayload.blockHash);

    this.logger.log('🔍 Searching for unproven bad performers');

    const proved = await Promise.all(keys.map((key) => this.exitPenalties.isEjectionProved(blockTag, key)));
    const unproven = keys.filter((key, i) => {
      if (proved[i]) {
        this.logger.warn(`Validator ${key.validatorIndex} already proven as a bad performer`);
        return false;
      }
      return true;
    });
    if (unproven.length == 0) {
      this.logger.log('All keys are already proven as bad performers');
      return undefined;
    }
    this.logger.log(`🔍 Unproven bad performers: ${unproven.length}`);
    return unproven;
  }

  private async getNonWithdrawnKeys(
    keys: InvolvedKeysWithBadPerformance,
  ): Promise<InvolvedKeysWithBadPerformance | undefined> {
    this.logger.log('🔍 Searching for non-withdrawn bad performers');

    const withdrawalProved = await Promise.all(keys.map((key) => this.stakingModule.isWithdrawalProved(key)));
    const nonWithdrawn = keys.filter((key, i) => {
      if (withdrawalProved[i]) {
        this.logger.warn(
          `Validator ${key.validatorIndex} already reported as withdrawn. No need to prove as a bad performer`,
        );
        return false;
      }
      return true;
    });
    if (nonWithdrawn.length == 0) {
      this.logger.log('All bad performers are already reported as withdrawn');
      return undefined;
    }
    this.logger.log(`🔍 Non-withdrawn bad performers: ${nonWithdrawn.length}`);
    return nonWithdrawn;
  }

  private async getStrikesThresholds(headBlockInfo: SupportedBlock): Promise<Map<number, number>> {
    const blockTag = toBlockTagByHash(headBlockInfo.body.executionPayload.blockHash);
    const thresholds = new Map<number, number>();

    const curvesCount = await this.accounting.getCurvesCount(blockTag);
    const curveIds = Array.from({ length: curvesCount }, (_, i) => i);
    const params = await Promise.all(curveIds.map((curveId) => this.params.getStrikeParams(blockTag, curveId)));
    curveIds.forEach((curveId, i) => thresholds.set(curveId, params[i].threshold));
    return thresholds;
  }

  private async getNodeOperatorsCurveIds(
    strikesTree: StandardMerkleTree<StrikesTreeLeaf>,
    headBlockInfo: SupportedBlock,
  ): Promise<Map<number, number>> {
    const blockTag = toBlockTagByHash(headBlockInfo.body.executionPayload.blockHash);
    const curveIds = new Map<number, number>();

    const noIds = [...new Set([...strikesTree.entries()].map((leaf) => leaf[1][0]))];
    const ids = await Promise.all(
      noIds.map((nodeOperatorId) => this.accounting.getBondCurveId(blockTag, nodeOperatorId)),
    );
    noIds.forEach((nodeOperatorId, i) => curveIds.set(nodeOperatorId, ids[i]));
    return curveIds;
  }

  private async getStrikesThresholdByNodeOperatorId(nodeOperatorId: number): Promise<number> {
    const curveId = this.currentNodeOperatorsCurveIds.get(nodeOperatorId);
    if (curveId === undefined) {
      throw new Error(`Curve Id for Node Operator ID ${nodeOperatorId} not found in the cache`);
    }
    const threshold = this.currentStrikesThresholdsByCurveId.get(curveId);
    if (threshold === undefined) {
      throw new Error(
        `Strikes threshold for Node Operator ID ${nodeOperatorId} (Curve ID ${curveId}) not found in the cache`,
      );
    }
    return threshold;
  }
}
