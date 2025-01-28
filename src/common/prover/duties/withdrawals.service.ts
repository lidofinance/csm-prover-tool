import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { CsmContract } from '../../contracts/csm-contract.service';
import { VerifierContract } from '../../contracts/verifier-contract.service';
import { Consensus, State, SupportedBlock, SupportedWithdrawal } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../../providers/consensus/response.interface';
import { WorkersService } from '../../workers/workers.service';
import { KeyInfo, KeyInfoFn } from '../types';

// according to the research https://hackmd.io/1wM8vqeNTjqt4pC3XoCUKQ?view#Proposed-solution
const FULL_WITHDRAWAL_MIN_AMOUNT = 8 * 10 ** 9; // 8 ETH in Gwei

type WithdrawalWithOffset = SupportedWithdrawal & { offset: number };
export type InvolvedKeysWithWithdrawal = { [valIndex: number]: KeyInfo & { withdrawal: WithdrawalWithOffset } };

@Injectable()
export class WithdrawalsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
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
      if (!proved) unproven[Number(valIndex)] = keyWithWithdrawalInfo;
    }
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.log('No full withdrawals to prove');
      return {};
    }
    this.logger.warn(`🔍 Unproven full withdrawals: ${unprovenCount}`);
    return unproven;
  }

  public async sendWithdrawalProofs(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
    if (!Object.keys(withdrawals).length) return;
    const blockHeader = await this.consensus.getBeaconHeader(blockRoot);
    const state = await this.consensus.getState(blockHeader.header.message.state_root);
    // There is a case when the block is not historical regarding the finalized block, but it is historical
    // regarding the transaction execution time. This is possible when long finalization time
    // The transaction will be reverted and the application will try to handle that block again
    if (this.isHistoricalBlock(blockInfo, finalizedHeader)) {
      this.logger.warn('It is historical withdrawal. Processing will take longer than usual');
      await this.sendHistoricalWithdrawalProofs(blockHeader, blockInfo, state, finalizedHeader, withdrawals);
    } else {
      await this.sendGeneralWithdrawalProofs(blockHeader, blockInfo, state, withdrawals);
    }
  }

  private async sendGeneralWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
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
      this.logger.log(`📡 Sending withdrawal proof payload for validator index: ${payload.witness.validatorIndex}`);
      await this.verifier.sendWithdrawalProof(payload);
    }
  }

  private async sendHistoricalWithdrawalProofs(
    blockHeader: BlockHeaderResponse,
    blockInfo: SupportedBlock,
    state: State,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
    // create proof against the historical state with withdrawals
    const nextBlockHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    if (!nextBlockHeader) throw new Error(`Next block header after ${finalizedHeader.root} not found`);
    const nextBlockTs = this.consensus.slotToTimestamp(Number(nextBlockHeader.header.message.slot));
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const summaryIndex = this.calcSummaryIndex(blockInfo);
    const summarySlot = this.calcSlotOfSummary(summaryIndex);
    const summaryState = await this.consensus.getState(summarySlot);
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
      rootIndexInSummary: this.calcRootIndexInSummary(blockInfo),
      withdrawals,
      epoch: this.consensus.slotToEpoch(Number(blockHeader.header.message.slot)),
    });
    for (const payload of payloads) {
      this.logger.log(
        `📡 Sending historical withdrawal proof payload for validator index: ${payload.witness.validatorIndex}`,
      );
      await this.verifier.sendHistoricalWithdrawalProof(payload);
    }
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

  private calcSummaryIndex(blockInfo: SupportedBlock): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return Math.floor((blockInfo.slot - capellaForkSlot) / slotsPerHistoricalRoot);
  }

  private calcSlotOfSummary(summaryIndex: number): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return capellaForkSlot + (summaryIndex + 1) * slotsPerHistoricalRoot;
  }

  private calcRootIndexInSummary(blockInfo: SupportedBlock): number {
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return blockInfo.slot % slotsPerHistoricalRoot;
  }
}
