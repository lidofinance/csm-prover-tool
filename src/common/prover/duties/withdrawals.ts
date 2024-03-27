import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { ForkName } from '@lodestar/params';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { CsmContract } from '../../contracts/csm-contract.service';
import { VerifierContract } from '../../contracts/verifier-contract.service';
import { Consensus } from '../../providers/consensus/consensus';
import {
  BlockHeaderResponse,
  BlockInfoResponse,
  RootHex,
  Withdrawal,
} from '../../providers/consensus/response.interface';
import {
  generateHistoricalStateProof,
  generateValidatorProof,
  generateWithdrawalProof,
  toHex,
  verifyProof,
} from '../helpers/proofs';
import { KeyInfo, KeyInfoFn, WithdrawalsGeneralProvePayload, WithdrawalsHistoricalProvePayload } from '../types';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;

// according to the research https://hackmd.io/1wM8vqeNTjqt4pC3XoCUKQ?view#Proposed-solution
const FULL_WITHDRAWAL_MIN_AMOUNT = 8 * 10 ** 18; // 8 ETH

type WithdrawalWithOffset = Withdrawal & { offset: number };
type InvolvedKeysWithWithdrawal = { [valIndex: string]: KeyInfo & { withdrawal: WithdrawalWithOffset } };

@Injectable()
export class WithdrawalsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly csm: CsmContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenWithdrawals(
    blockInfo: BlockInfoResponse,
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
      this.logger.log('No full withdrawals to prove');
      return {};
    }
    this.logger.warn(`🔍 Unproven full withdrawals: ${unprovenCount}`);
    return unproven;
  }

  public async sendWithdrawalProves(
    blockRoot: RootHex,
    blockInfo: BlockInfoResponse,
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
    if (!Object.keys(withdrawals).length) return;
    const blockHeader = await this.consensus.getBeaconHeader(blockRoot);
    this.logger.log(`Getting state for root [${blockRoot}]`);
    const state = await this.consensus.getState(blockHeader.header.message.state_root);
    // There is a case when the block is not historical regarding the finalized block, but it is historical
    // regarding the transaction execution time. This is possible when long finalization time
    // The transaction will be reverted and the application will try to handle that block again
    if (this.isHistoricalBlock(blockInfo, finalizedHeader)) {
      this.logger.warn('It is historical withdrawal. Processing will take longer than usual');
      await this.sendHistoricalWithdrawalProves(blockHeader, blockInfo, state, finalizedHeader, withdrawals);
    } else {
      await this.sendGeneralWithdrawalProves(blockHeader, blockInfo, state, withdrawals);
    }
  }

  private async sendGeneralWithdrawalProves(
    blockHeader: BlockHeaderResponse,
    blockInfo: BlockInfoResponse,
    state: { bodyBytes: Uint8Array; forkName: keyof typeof ForkName },
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
    // create proof against the state with withdrawals
    const nextBlockHeader = (await this.consensus.getBeaconHeadersByParentRoot(blockHeader.root)).data[0];
    const nextBlockTs = this.consensus.slotToTimestamp(Number(nextBlockHeader.header.message.slot));
    const payloads = this.buildWithdrawalsProveGeneralPayloads(
      blockHeader,
      nextBlockTs,
      this.consensus.stateToView(state.bodyBytes, state.forkName),
      this.consensus.blockToView(blockInfo, state.forkName),
      withdrawals,
    );
    for (const payload of payloads) {
      this.logger.warn(`📡 Sending withdrawal prove payload for validator index: ${payload.witness.validatorIndex}`);
      await this.verifier.sendGeneralWithdrawalProve(payload);
    }
  }

  private async sendHistoricalWithdrawalProves(
    blockHeader: BlockHeaderResponse,
    blockInfo: BlockInfoResponse,
    state: { bodyBytes: Uint8Array; forkName: keyof typeof ForkName },
    finalizedHeader: BlockHeaderResponse,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Promise<void> {
    // create proof against the historical state with withdrawals
    const nextBlockHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    const nextBlockTs = this.consensus.slotToTimestamp(Number(nextBlockHeader.header.message.slot));
    this.logger.log(`Getting state for root [${finalizedHeader.root}]`);
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const summaryIndex = this.calcSummaryIndex(blockInfo);
    const summarySlot = this.calcSlotOfSummary(summaryIndex);
    this.logger.log(`Getting state for slot [${summarySlot}]`);
    const summaryState = await this.consensus.getState(summarySlot);
    const payloads = this.buildWithdrawalsProveHistoricalPayloads(
      blockHeader,
      finalizedHeader,
      nextBlockTs,
      this.consensus.stateToView(finalizedState.bodyBytes, finalizedState.forkName),
      this.consensus.stateToView(summaryState.bodyBytes, summaryState.forkName),
      this.consensus.stateToView(state.bodyBytes, state.forkName),
      this.consensus.blockToView(blockInfo, state.forkName),
      summaryIndex,
      this.calcRootIndexInSummary(blockInfo),
      withdrawals,
    );
    for (const payload of payloads) {
      this.logger.warn(
        `📡 Sending historical withdrawal prove payload for validator index: ${payload.witness.validatorIndex}`,
      );
      await this.verifier.sendHistoricalWithdrawalProve(payload);
    }
  }

  private getFullWithdrawals(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeysWithWithdrawal {
    const fullWithdrawals: InvolvedKeysWithWithdrawal = {};
    const withdrawals = blockInfo.message.body.execution_payload?.withdrawals ?? [];
    for (let i = 0; i < withdrawals.length; i++) {
      const keyInfo = keyInfoFn(Number(withdrawals[i].validator_index));
      if (!keyInfo) continue;
      if (Number(withdrawals[i].amount) < FULL_WITHDRAWAL_MIN_AMOUNT) continue;
      fullWithdrawals[withdrawals[i].validator_index] = { ...keyInfo, withdrawal: { ...withdrawals[i], offset: i } };
    }
    return fullWithdrawals;
  }

  private *buildWithdrawalsProveGeneralPayloads(
    currentHeader: BlockHeaderResponse,
    nextHeaderTimestamp: number,
    stateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
    currentBlockView: ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Generator<WithdrawalsGeneralProvePayload> {
    const epoch = this.consensus.slotToEpoch(Number(currentHeader.header.message.slot));
    for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
      const validator = stateView.validators.get(Number(valIndex));
      if (epoch < validator.withdrawableEpoch) {
        this.logger.warn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
        continue;
      }
      const validatorProof = generateValidatorProof(stateView, Number(valIndex));
      const withdrawalProof = generateWithdrawalProof(
        stateView,
        currentBlockView,
        keyWithWithdrawalInfo.withdrawal.offset,
      );
      // verify validator proof
      verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
      // verify withdrawal proof
      verifyProof(
        stateView.hashTreeRoot(),
        withdrawalProof.gindex,
        withdrawalProof.witnesses,
        (
          currentBlockView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
        ).body.executionPayload.withdrawals
          .get(keyWithWithdrawalInfo.withdrawal.offset)
          .hashTreeRoot(),
      );
      yield {
        keyIndex: keyWithWithdrawalInfo.keyIndex,
        nodeOperatorId: keyWithWithdrawalInfo.operatorId,
        beaconBlock: {
          header: {
            slot: currentHeader.header.message.slot,
            proposerIndex: Number(currentHeader.header.message.proposer_index),
            parentRoot: currentHeader.header.message.parent_root,
            stateRoot: currentHeader.header.message.state_root,
            bodyRoot: currentHeader.header.message.body_root,
          },
          rootsTimestamp: nextHeaderTimestamp,
        },
        witness: {
          withdrawalOffset: Number(keyWithWithdrawalInfo.withdrawal.offset),
          withdrawalIndex: Number(keyWithWithdrawalInfo.withdrawal.index),
          validatorIndex: Number(keyWithWithdrawalInfo.withdrawal.validator_index),
          amount: Number(keyWithWithdrawalInfo.withdrawal.amount),
          withdrawalCredentials: toHex(validator.withdrawalCredentials),
          effectiveBalance: validator.effectiveBalance,
          slashed: Boolean(validator.slashed),
          activationEligibilityEpoch: validator.activationEligibilityEpoch,
          activationEpoch: validator.activationEpoch,
          exitEpoch: validator.exitEpoch,
          withdrawableEpoch: validator.withdrawableEpoch,
          withdrawalProof: withdrawalProof.witnesses.map(toHex),
          validatorProof: validatorProof.witnesses.map(toHex),
        },
      };
    }
  }

  private *buildWithdrawalsProveHistoricalPayloads(
    headerWithWds: BlockHeaderResponse,
    finalHeader: BlockHeaderResponse,
    nextToFinalizedHeaderTimestamp: number,
    finalizedStateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
    summaryStateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
    stateWithWdsView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
    blockWithWdsView: ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>,
    summaryIndex: number,
    rootIndexInSummary: number,
    withdrawals: InvolvedKeysWithWithdrawal,
  ): Generator<WithdrawalsHistoricalProvePayload> {
    const epoch = this.consensus.slotToEpoch(Number(headerWithWds.header.message.slot));
    for (const [valIndex, keyWithWithdrawalInfo] of Object.entries(withdrawals)) {
      const validator = stateWithWdsView.validators.get(Number(valIndex));
      if (epoch < validator.withdrawableEpoch) {
        this.logger.warn(`Validator ${valIndex} is not full withdrawn. Just huge amount of ETH. Skipped`);
        continue;
      }
      const validatorProof = generateValidatorProof(stateWithWdsView, Number(valIndex));
      const withdrawalProof = generateWithdrawalProof(
        stateWithWdsView,
        blockWithWdsView,
        keyWithWithdrawalInfo.withdrawal.offset,
      );
      const historicalStateProof = generateHistoricalStateProof(
        finalizedStateView,
        summaryStateView,
        summaryIndex,
        rootIndexInSummary,
      );
      // verify validator proof
      verifyProof(
        stateWithWdsView.hashTreeRoot(),
        validatorProof.gindex,
        validatorProof.witnesses,
        validator.hashTreeRoot(),
      );
      // verify withdrawal proof
      verifyProof(
        stateWithWdsView.hashTreeRoot(),
        withdrawalProof.gindex,
        withdrawalProof.witnesses,
        (
          blockWithWdsView as ContainerTreeViewType<typeof ssz.capella.BeaconBlock.fields>
        ).body.executionPayload.withdrawals
          .get(keyWithWithdrawalInfo.withdrawal.offset)
          .hashTreeRoot(),
      );
      // verify historical state proof
      verifyProof(
        finalizedStateView.hashTreeRoot(),
        historicalStateProof.gindex,
        historicalStateProof.witnesses,
        (summaryStateView as ContainerTreeViewType<typeof ssz.capella.BeaconState.fields>).blockRoots.get(
          rootIndexInSummary,
        ),
      );
      yield {
        keyIndex: keyWithWithdrawalInfo.keyIndex,
        nodeOperatorId: keyWithWithdrawalInfo.operatorId,
        beaconBlock: {
          header: {
            slot: finalHeader.header.message.slot,
            proposerIndex: Number(finalHeader.header.message.proposer_index),
            parentRoot: finalHeader.header.message.parent_root,
            stateRoot: finalHeader.header.message.state_root,
            bodyRoot: finalHeader.header.message.body_root,
          },
          rootsTimestamp: nextToFinalizedHeaderTimestamp,
        },
        oldBlock: {
          header: {
            slot: headerWithWds.header.message.slot,
            proposerIndex: Number(headerWithWds.header.message.proposer_index),
            parentRoot: headerWithWds.header.message.parent_root,
            stateRoot: headerWithWds.header.message.state_root,
            bodyRoot: headerWithWds.header.message.body_root,
          },
          // NOTE: the last byte can be changed due to `CSVerifier` implementation in the future
          rootGIndex: '0x' + (historicalStateProof.gindex.toString(16) + '00').padStart(64, '0'),
          proof: historicalStateProof.witnesses.map(toHex),
        },
        witness: {
          withdrawalOffset: Number(keyWithWithdrawalInfo.withdrawal.offset),
          withdrawalIndex: Number(keyWithWithdrawalInfo.withdrawal.index),
          validatorIndex: Number(keyWithWithdrawalInfo.withdrawal.validator_index),
          amount: Number(keyWithWithdrawalInfo.withdrawal.amount),
          withdrawalCredentials: toHex(validator.withdrawalCredentials),
          effectiveBalance: validator.effectiveBalance,
          slashed: Boolean(validator.slashed),
          activationEligibilityEpoch: validator.activationEligibilityEpoch,
          activationEpoch: validator.activationEpoch,
          exitEpoch: validator.exitEpoch,
          withdrawableEpoch: validator.withdrawableEpoch,
          withdrawalProof: withdrawalProof.witnesses.map(toHex),
          validatorProof: validatorProof.witnesses.map(toHex),
        },
      };
    }
  }

  private isHistoricalBlock(blockInfo: BlockInfoResponse, finalizedHeader: BlockHeaderResponse): boolean {
    const finalizationBufferEpochs = 2;
    const finalizationBufferSlots = this.consensus.epochToSlot(finalizationBufferEpochs);
    return (
      Number(finalizedHeader.header.message.slot) - Number(blockInfo.message.slot) >
      Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT) - finalizationBufferSlots
    );
  }

  private calcSummaryIndex(blockInfo: BlockInfoResponse): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return Math.floor((Number(blockInfo.message.slot) - capellaForkSlot) / slotsPerHistoricalRoot);
  }

  private calcSlotOfSummary(summaryIndex: number): number {
    const capellaForkSlot = this.consensus.epochToSlot(Number(this.consensus.beaconConfig.CAPELLA_FORK_EPOCH));
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return capellaForkSlot + (summaryIndex + 1) * slotsPerHistoricalRoot;
  }

  private calcRootIndexInSummary(blockInfo: BlockInfoResponse): number {
    const slotsPerHistoricalRoot = Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT);
    return Number(blockInfo.message.slot) % slotsPerHistoricalRoot;
  }
}
