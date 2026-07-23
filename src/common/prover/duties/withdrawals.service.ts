import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { ForkName } from '@lodestar/params';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { StakingModuleContract } from '../../contracts/staking-module-contract.service.js';
import type { IVerifier } from '../../contracts/types/Verifier.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus, type State } from '../../providers/consensus/consensus.js';
import type { SupportedBlock, SupportedWithdrawal } from '../../providers/consensus/forks.js';
import { type BlockHeaderResponse, firstCanonical } from '../../providers/consensus/response.interface.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfo, KeyInfoFn } from '../types.js';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../utils/historical-summary.js';

// according to the research https://hackmd.io/1wM8vqeNTjqt4pC3XoCUKQ?view#Proposed-solution
const FULL_WITHDRAWAL_MIN_AMOUNT = 8 * 10 ** 9; // 8 ETH in Gwei

type WithdrawalWithOffset = SupportedWithdrawal & { offset: number };
export type InvolvedKeysWithWithdrawal = { [valIndex: string]: KeyInfo & { withdrawal: WithdrawalWithOffset } };

@Injectable()
export class WithdrawalsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenWithdrawals(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    keyInfoFn: KeyInfoFn,
  ): Promise<InvolvedKeysWithWithdrawal> {
    const withdrawals = this.getFullWithdrawals(await this.getWithdrawals(blockRoot, blockInfo), keyInfoFn);
    if (!Object.keys(withdrawals).length) return {};
    const entries = Object.entries(withdrawals);
    const proved = await Promise.all(entries.map(([, k]) => this.stakingModule.isWithdrawalProved(k)));
    const unproven: InvolvedKeysWithWithdrawal = Object.fromEntries(entries.filter((_, i) => !proved[i]));
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.warn('All full withdrawals from this block are already proved');
      return {};
    }
    this.logger.log(`🔍 Unproven full withdrawals: ${unprovenCount}`);
    return unproven;
  }

  public async sendWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<number> {
    if (!Object.keys(withdrawals).length) return 0;
    // There is a case when the block is not historical regarding the finalized block, but it is historical
    // regarding the transaction execution time. This is possible when long finalization time
    // The transaction will be reverted and the application will try to handle that block again
    if (this.isHistoricalBlock(blockInfo, finalizedHeader)) {
      this.logger.warn('It is historical withdrawal. Processing will take longer than usual');
      const payloads = await this.sendHistoricalWithdrawalProofs(blockHeader, blockInfo, state, withdrawals);
      return payloads.length;
    }
    const payloads = await this.sendGeneralWithdrawalProofs(
      blockHeader,
      blockInfo,
      state,
      finalizedHeader,
      withdrawals,
    );
    return payloads.length;
  }

  private async sendGeneralWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
    const withdrawalSlot = Number(blockHeader.header.message.slot);
    const finalizedSlot = Number(finalizedHeader.header.message.slot);
    let recentHeader = finalizedHeader;
    if (finalizedSlot <= withdrawalSlot) {
      recentHeader = firstCanonical((await this.consensus.getBeaconHeadersByParentRoot(blockHeader.root)).data)!;
      if (!recentHeader) throw new Error(`Recent canonical block header after ${blockHeader.root} not found`);
    }
    const recentSlot = Number(recentHeader.header.message.slot);
    const historicalRootLimit = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    if (recentSlot <= withdrawalSlot || recentSlot - withdrawalSlot > historicalRootLimit) {
      throw new Error(`Withdrawal block slot ${withdrawalSlot} is not in recent block_roots at slot ${recentSlot}`);
    }
    const recentState = await this.consensus.getState(toRootHex(recentHeader.header.message.stateRoot));
    const nextBlockHeader = firstCanonical((await this.consensus.getBeaconHeadersByParentRoot(recentHeader.root)).data);
    if (!nextBlockHeader) throw new Error(`Next canonical block header after ${recentHeader.root} not found`);
    const nextBlockTs = await this.getRootsTimestamp(recentHeader, nextBlockHeader, recentState);
    this.logger.log(`Building withdrawal proof payloads`);
    const payloads = await this.workers.getGeneralWithdrawalProofPayloads({
      withdrawalHeader: blockHeader,
      recentHeader,
      nextHeaderTimestamp: nextBlockTs,
      withdrawalState: state,
      recentState,
      withdrawalBlock: blockInfo,
      withdrawals,
      epoch: this.consensus.slotToEpoch(Number(blockHeader.header.message.slot)),
    });
    for (const payload of payloads) {
      this.logger.log(`📡 Sending withdrawal proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendWithdrawalProof(payload);
    }
    return payloads;
  }

  private async sendHistoricalWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<IVerifier.ProcessHistoricalWithdrawalInputStruct[]> {
    // create proof against the historical state with withdrawals.
    // Anchor to the freshest finalized header, fetched as late as possible: its root must still be in
    // the EIP-4788 ring buffer (~27h) when the tx executes. A header captured at the start of the daemon
    // iteration can age out during slow historical proof generation → RootNotFound() revert.
    const finalizedHeader = await this.consensus.getBeaconHeader('finalized');
    const finalizedState = await this.consensus.getState(toRootHex(finalizedHeader.header.message.stateRoot));
    const nextBlockHeader = firstCanonical(
      (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data,
    );
    if (!nextBlockHeader) throw new Error(`Next canonical block header after ${finalizedHeader.root} not found`);
    const nextBlockTs = await this.getRootsTimestamp(finalizedHeader, nextBlockHeader, finalizedState);
    const summaryResolution = await resolveHistoricalSummaryContext(
      this.consensus,
      finalizedHeader,
      Number(blockInfo.slot),
    );
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.BeforeCapella) {
      throw new Error('Historical summary is not available before Capella fork slot');
    }
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.NotHistoricalYet) {
      throw new Error(`Historical summary is not available yet (summary slot ${summaryResolution.summarySlot})`);
    }
    const { summaryState, summaryIndex, rootIndexInSummary } = summaryResolution.context;
    this.logger.log('Building historical withdrawal proof payloads');
    const payloads = await this.workers.getHistoricalWithdrawalProofPayloads({
      headerWithWds: blockHeader,
      finalHeader: finalizedHeader,
      nextToFinalizedHeaderTimestamp: nextBlockTs,
      finalizedState,
      summaryState,
      stateWithWds: state,
      blockWithWds: blockInfo,
      summaryIndex,
      rootIndexInSummary,
      withdrawals,
      epoch: this.consensus.slotToEpoch(Number(blockHeader.header.message.slot)),
    });
    for (const payload of payloads) {
      this.logger.log(`📡 Sending historical withdrawal proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendHistoricalWithdrawalProof(payload);
    }
    return payloads;
  }

  private getFullWithdrawals(
    withdrawals: SupportedWithdrawal[],
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeysWithWithdrawal {
    const fullWithdrawals: InvolvedKeysWithWithdrawal = {};
    for (let i = 0; i < withdrawals.length; i++) {
      const keyInfo = keyInfoFn(withdrawals[i].validatorIndex);
      if (!keyInfo) continue;
      if (Number(withdrawals[i].amount) < FULL_WITHDRAWAL_MIN_AMOUNT) continue;
      fullWithdrawals[withdrawals[i].validatorIndex] = { ...keyInfo, withdrawal: { ...withdrawals[i], offset: i } };
    }
    return fullWithdrawals;
  }

  private async getWithdrawals(blockRoot: RootHex, blockInfo: SupportedBlock): Promise<SupportedWithdrawal[]> {
    if ('executionPayload' in blockInfo.body) return blockInfo.body.executionPayload.withdrawals;
    const envelope = await this.consensus.getExecutionPayloadEnvelope(blockRoot);
    return envelope.payload.withdrawals as SupportedWithdrawal[];
  }

  private async getRootsTimestamp(
    parentHeader: BlockHeaderResponse,
    childHeader: BlockHeaderResponse,
    parentState: State,
  ): Promise<number> {
    if (parentState.forkName !== ForkName.gloas) {
      return this.consensus.slotToTimestamp(Number(childHeader.header.message.slot));
    }

    const envelope = await this.consensus.getExecutionPayloadEnvelope(childHeader.root);
    if (toRootHex(envelope.parentBeaconBlockRoot).toLowerCase() !== parentHeader.root.toLowerCase()) {
      throw new Error(`Execution payload envelope [${childHeader.root}] does not anchor block [${parentHeader.root}]`);
    }
    return Number(envelope.payload.timestamp);
  }

  private isHistoricalBlock(blockInfo: SupportedBlock, finalizedHeader: BlockHeaderResponse): boolean {
    const finalizationBufferEpochs = 2;
    const finalizationBufferSlots = this.consensus.epochToSlot(finalizationBufferEpochs);
    return (
      Number(finalizedHeader.header.message.slot) - Number(blockInfo.slot) >=
      Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT) - finalizationBufferSlots
    );
  }
}
