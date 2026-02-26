import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import { CsmContract } from '../../contracts/csm-contract.service.js';
import type { IVerifier } from '../../contracts/types/Verifier.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus, type State } from '../../providers/consensus/consensus.js';
import type { SupportedBlock, SupportedWithdrawal } from '../../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
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
    protected readonly csm: CsmContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenWithdrawals(
    blockInfo: SupportedBlock,
    keyInfoFn: KeyInfoFn,
  ): Promise<InvolvedKeysWithWithdrawal> {
    const withdrawals = this.getFullWithdrawals(blockInfo, keyInfoFn);
    if (!Object.keys(withdrawals).length) return {};
    const unproven: InvolvedKeysWithWithdrawal = {};
    for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
      const proved = await this.csm.isWithdrawalProved(keyWithWithdrawalInfo);
      if (!proved) unproven[valIndex] = keyWithWithdrawalInfo;
    }
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.warn('All full withdrawals from this block are already proved');
      return {};
    }
    this.logger.log(`🔍 Unproven full withdrawals: ${unprovenCount}`);
    return unproven;
  }

  public async sendWithdrawalProofs(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<number> {
    if (!Object.keys(withdrawals).length) return 0;
    const blockHeader = await this.consensus.getBeaconHeader(blockRoot);
    const state = await this.consensus.getState(toRootHex(blockHeader.header.message.stateRoot));
    // There is a case when the block is not historical regarding the finalized block, but it is historical
    // regarding the transaction execution time. This is possible when long finalization time
    // The transaction will be reverted and the application will try to handle that block again
    if (this.isHistoricalBlock(blockInfo, finalizedHeader)) {
      this.logger.warn('It is historical withdrawal. Processing will take longer than usual');
      const payloads = await this.sendHistoricalWithdrawalProofs(
        blockHeader,
        blockInfo,
        state,
        finalizedHeader,
        withdrawals,
      );
      return payloads.length;
    }
    const payloads = await this.sendGeneralWithdrawalProofs(blockHeader, blockInfo, state, withdrawals);
    return payloads.length;
  }

  private async sendGeneralWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
    // create proof against the state with withdrawals
    const nextBlockHeader = (await this.consensus.getBeaconHeadersByParentRoot(blockHeader.root)).data[0];
    if (!nextBlockHeader) throw new Error(`Next block header after ${blockHeader.root} not found`);
    const nextBlockTs = this.consensus.slotToTimestamp(Number(nextBlockHeader.header.message.slot));
    this.logger.log(`Building withdrawal proof payloads`);
    const payloads = await this.workers.getGeneralWithdrawalProofPayloads({
      currentHeader: blockHeader,
      nextHeaderTimestamp: nextBlockTs,
      state,
      currentBlock: blockInfo,
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
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<IVerifier.ProcessHistoricalWithdrawalInputStruct[]> {
    // create proof against the historical state with withdrawals
    const nextBlockHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    if (!nextBlockHeader) throw new Error(`Next block header after ${finalizedHeader.root} not found`);
    const nextBlockTs = this.consensus.slotToTimestamp(Number(nextBlockHeader.header.message.slot));
    const finalizedState = await this.consensus.getState(toRootHex(finalizedHeader.header.message.stateRoot));
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
    blockInfo: SupportedBlock,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeysWithWithdrawal {
    const fullWithdrawals: InvolvedKeysWithWithdrawal = {};
    const withdrawals = blockInfo.body.executionPayload.withdrawals;
    for (let i = 0; i < withdrawals.length; i++) {
      const keyInfo = keyInfoFn(withdrawals[i].validatorIndex);
      if (!keyInfo) continue;
      if (Number(withdrawals[i].amount) < FULL_WITHDRAWAL_MIN_AMOUNT) continue;
      fullWithdrawals[withdrawals[i].validatorIndex] = { ...keyInfo, withdrawal: { ...withdrawals[i], offset: i } };
    }
    return fullWithdrawals;
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
