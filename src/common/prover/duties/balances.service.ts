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

  public isProvableBalance(keyAddedBalanceWei: bigint, balanceGwei: bigint, exitEpoch: bigint): boolean {
    const minActivationBalanceGwei = BigInt(this.consensus.beaconConfig.MIN_ACTIVATION_BALANCE);
    const maxEffectiveBalanceGwei = BigInt(this.consensus.beaconConfig.MAX_EFFECTIVE_BALANCE_ELECTRA);
    const reportableMaxGwei = maxEffectiveBalanceGwei - BigInt(this.config.get('BALANCE_PROOF_TOPUP_STEP_GWEI'));
    const keyConfirmedBalanceGwei = keyAddedBalanceWei / 1_000_000_000n;
    const confirmedBalanceGwei = minActivationBalanceGwei + keyConfirmedBalanceGwei;
    if (reportableMaxGwei <= confirmedBalanceGwei) return false;
    if (balanceGwei <= confirmedBalanceGwei) return false;

    const balanceDeltaGwei = balanceGwei - confirmedBalanceGwei;
    return (
      balanceDeltaGwei > BigInt(this.config.get('BALANCE_PROOF_MIN_DELTA_GWEI')) ||
      exitEpoch !== FAR_FUTURE_EPOCH ||
      balanceGwei >= reportableMaxGwei
    );
  }

  public async getUnprovenBalanceChangeProofs(currentState: State, keys: InvolvedKeys): Promise<InvolvedKeys> {
    const keysCount = Object.keys(keys).length;
    if (keysCount === 0) return {};

    const currentBalances = await this.getValidatorBalances(currentState);
    const currentExitEpochs = await this.getValidatorExitEpochs(currentState);
    const minActivationBalanceGwei = BigInt(this.consensus.beaconConfig.MIN_ACTIVATION_BALANCE);
    const provable: InvolvedKeys = {};

    // Validators not yet in the state are skipped — keys data can be more recent than the state due to async
    // processing; they retry next block. A balance <= MIN_ACTIVATION_BALANCE can never be provable (confirmed
    // balance is always >= MIN_ACTIVATION_BALANCE), so drop those before the on-chain confirmed-balance reads.
    const entries = Object.entries(keys).filter(([valIndex]) => {
      const balance = currentBalances[Number(valIndex)];
      return balance !== undefined && balance > minActivationBalanceGwei;
    });
    const addedBalances = await this.stakingModule.getKeyAddedBalances(entries.map(([, keyInfo]) => keyInfo));

    entries.forEach(([valIndex, keyInfo], i) => {
      const balanceToProve = currentBalances[Number(valIndex)];
      const exitEpochToProve = currentExitEpochs[Number(valIndex)];
      if (this.isProvableBalance(addedBalances[i], balanceToProve, exitEpochToProve)) {
        provable[valIndex] = keyInfo;
      }
    });

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
      const payloads = await this.sendHistoricalBalanceProofs(blockHeader, state, balanceChanges);
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
    balanceChanges: InvolvedKeys,
  ): Promise<IVerifier.ProcessHistoricalBalanceProofInputStruct[]> {
    // Get the freshest finalized header: A header captured at the start of the daemon iteration
    // can age out during slow historical proof generation → RootNotFound() revert.
    const recentHeader = await this.consensus.getBeaconHeader('finalized');
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
