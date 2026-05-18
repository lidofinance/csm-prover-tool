import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { ConfigService } from '../../config/config.service.js';
import { StakingModuleContract } from '../../contracts/staking-module-contract.service.js';
import type { IVerifier } from '../../contracts/types/Verifier.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus, type State } from '../../providers/consensus/consensus.js';
import { FAR_FUTURE_EPOCH } from '../../providers/consensus/epoch.js';
import { type BlockHeaderResponse, firstCanonical } from '../../providers/consensus/response.interface.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfo } from '../types.js';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../utils/historical-summary.js';

export type InvolvedKeys = { [valIndex: string]: KeyInfo };

@Injectable()
export class BalancesService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async isProvableBalance(keyInfo: KeyInfo, balanceGwei: bigint, exitEpoch: bigint): Promise<boolean> {
    const minActivationBalanceGwei = BigInt(this.consensus.beaconConfig.MIN_ACTIVATION_BALANCE);
    const maxEffectiveBalanceGwei = BigInt(this.consensus.beaconConfig.MAX_EFFECTIVE_BALANCE_ELECTRA);
    const keyConfirmedBalanceGwei = (await this.stakingModule.getKeyAddedBalance(keyInfo)) / 1_000_000_000n;
    const confirmedBalanceGwei = minActivationBalanceGwei + keyConfirmedBalanceGwei;
    if (maxEffectiveBalanceGwei <= confirmedBalanceGwei) return false;
    if (balanceGwei <= confirmedBalanceGwei) return false;

    const balanceDeltaGwei = balanceGwei - confirmedBalanceGwei;
    return (
      balanceDeltaGwei > BigInt(this.config.get('BALANCE_PROOF_MIN_DELTA_GWEI')) ||
      exitEpoch !== FAR_FUTURE_EPOCH ||
      balanceGwei >= maxEffectiveBalanceGwei
    );
  }

  public async getUnprovenBalanceChangeProofs(currentState: State, keys: InvolvedKeys): Promise<InvolvedKeys> {
    const keysCount = Object.keys(keys).length;
    if (keysCount === 0) return {};

    const currentBalances = await this.getValidatorBalances(currentState);
    const currentExitEpochs = await this.getValidatorExitEpochs(currentState);
    const provable: InvolvedKeys = {};

    for (const [valIndex, keyInfo] of Object.entries(keys)) {
      const balanceToProve = currentBalances[Number(valIndex)];
      if (balanceToProve === undefined) {
        // No validator in the state yet. Probably, keys data is likely more recent than the state due to async processing.
        // Skip for now, the next block will have updated state and may include these validator.
        continue;
      }
      const exitEpochToProve = currentExitEpochs[Number(valIndex)];
      const isProvable = await this.isProvableBalance(keyInfo, balanceToProve, exitEpochToProve);
      if (isProvable) {
        provable[valIndex] = keyInfo;
      }
    }

    const provableCount = Object.keys(provable).length;
    if (!provableCount) {
      this.logger.log('No additional balances to prove');
      return {};
    }

    this.logger.warn(`🔍 Provable additional balances: ${provableCount}`);
    return provable;
  }

  public async sendBalanceChangeProofs(
    blockHeader: BlockHeaderResponse,
    recentHeader: BlockHeaderResponse,
    state: State,
    balanceChanges: InvolvedKeys,
  ): Promise<number> {
    if (!Object.keys(balanceChanges).length) return 0;
    if (this.isHistoricalBlock(blockHeader, recentHeader)) {
      this.logger.warn('Balance proof block is historical. Processing will take longer than usual');
      const payloads = await this.sendHistoricalBalanceProofs(blockHeader, state, recentHeader, balanceChanges);
      return payloads.length;
    }

    const payloads = await this.sendGeneralBalanceProofs(blockHeader, state, balanceChanges);
    return payloads.length;
  }

  private async getValidatorBalances(state: State): Promise<bigint[]> {
    return await this.workers.getValidatorBalances({ state });
  }

  private async getValidatorExitEpochs(state: State): Promise<bigint[]> {
    return await this.workers.getValidatorExitEpochs({ state });
  }

  private async sendGeneralBalanceProofs(
    blockHeader: BlockHeaderResponse,
    state: State,
    balanceChanges: InvolvedKeys,
  ): Promise<IVerifier.ProcessBalanceProofInputStruct[]> {
    const nextHeader = firstCanonical((await this.consensus.getBeaconHeadersByParentRoot(blockHeader.root)).data);
    if (!nextHeader) throw new Error(`Next canonical block header after ${blockHeader.root} not found`);
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));
    this.logger.log('Building balance proof payloads');
    const payloads = await this.workers.getBalanceProofPayloads({
      currentHeader: blockHeader,
      nextHeaderTimestamp: nextHeaderTs,
      state,
      keys: balanceChanges,
    });

    for (const payload of payloads) {
      this.logger.log(`📡 Sending balance proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendBalanceProof(payload);
    }
    return payloads;
  }

  private async sendHistoricalBalanceProofs(
    blockHeader: BlockHeaderResponse,
    state: State,
    recentHeader: BlockHeaderResponse,
    balanceChanges: InvolvedKeys,
  ): Promise<IVerifier.ProcessHistoricalBalanceProofInputStruct[]> {
    const nextHeader = firstCanonical((await this.consensus.getBeaconHeadersByParentRoot(recentHeader.root)).data);
    if (!nextHeader) throw new Error(`Next canonical block header after ${recentHeader.root} not found`);
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));
    const recentState = await this.consensus.getState(toRootHex(recentHeader.header.message.stateRoot));
    const summaryResolution = await resolveHistoricalSummaryContext(
      this.consensus,
      recentHeader,
      Number(blockHeader.header.message.slot),
    );
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.BeforeCapella) {
      throw new Error('Historical summary is not available before Capella fork slot');
    }
    if (summaryResolution.status === HistoricalSummaryResolutionStatus.NotHistoricalYet) {
      throw new Error(`Historical summary is not available yet (summary slot ${summaryResolution.summarySlot})`);
    }

    const { summaryState, summaryIndex, rootIndexInSummary } = summaryResolution.context;
    this.logger.log('Building historical balance proof payloads');
    const payloads = await this.workers.getHistoricalBalanceProofPayloads({
      headerWithBalances: blockHeader,
      recentHeader,
      nextToRecentHeaderTimestamp: nextHeaderTs,
      stateWithBalances: state,
      recentState,
      summaryState,
      summaryIndex,
      rootIndexInSummary,
      keys: balanceChanges,
    });

    for (const payload of payloads) {
      this.logger.log(`📡 Sending historical balance proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendHistoricalBalanceProof(payload);
    }

    return payloads;
  }

  private isHistoricalBlock(blockHeader: BlockHeaderResponse, recentHeader: BlockHeaderResponse): boolean {
    const finalizationBufferEpochs = 2;
    const finalizationBufferSlots = this.consensus.epochToSlot(finalizationBufferEpochs);
    return (
      Number(recentHeader.header.message.slot) - Number(blockHeader.header.message.slot) >=
      Number(this.consensus.beaconConfig.SLOTS_PER_HISTORICAL_ROOT) - finalizationBufferSlots
    );
  }
}
