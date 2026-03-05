import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { ConfigService } from '../../config/config.service.js';
import { CsmContract } from '../../contracts/csm-contract.service.js';
import type { IVerifier } from '../../contracts/types/Verifier.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus, type State } from '../../providers/consensus/consensus.js';
import type { BlockHeaderResponse } from '../../providers/consensus/response.interface.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfo } from '../types.js';
import { HistoricalSummaryResolutionStatus, resolveHistoricalSummaryContext } from '../utils/historical-summary.js';

export type InvolvedKeys = { [valIndex: string]: KeyInfo };

const MIN_ACTIVATION_BALANCE_GWEI = 32_000_000_000n; // 32 ETH
const MAX_EFFECTIVE_BALANCE_GWEI = 2_048_000_000_000n; // 2048 ETH

@Injectable()
export class BalancesService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly csm: CsmContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async isProvableBalance(keyInfo: KeyInfo, currentBalanceGwei: bigint): Promise<boolean> {
    const onchainKeyAddedBalanceGwei = (await this.csm.getKeyAddedBalance(keyInfo)) / 1_000_000_000n;
    if (currentBalanceGwei < MIN_ACTIVATION_BALANCE_GWEI) return false;

    const cappedBalance =
      currentBalanceGwei > MAX_EFFECTIVE_BALANCE_GWEI ? MAX_EFFECTIVE_BALANCE_GWEI : currentBalanceGwei;
    const newKeyAddedBalanceGwei = cappedBalance - MIN_ACTIVATION_BALANCE_GWEI;

    return (
      newKeyAddedBalanceGwei - onchainKeyAddedBalanceGwei >= BigInt(this.config.get('BALANCE_PROOF_MIN_DELTA_GWEI'))
    );
  }

  public async getUnprovenBalanceChangeProofs(
    currentState: State,
    keys: InvolvedKeys,
    previousState?: State,
  ): Promise<InvolvedKeys> {
    const keysCount = Object.keys(keys).length;
    if (keysCount === 0) return {};

    const currentBalances = await this.getValidatorBalances(currentState);
    const previousBalances = previousState ? await this.getValidatorBalances(previousState) : undefined;
    const provable: InvolvedKeys = {};

    for (const [valIndex, keyInfo] of Object.entries(keys)) {
      const currentBalance = this.getBalanceOrThrow(currentBalances, valIndex, keysCount);
      let balanceToProve = currentBalance;

      if (previousBalances) {
        const previousBalance = previousBalances[Number(valIndex)];
        if (previousBalance === undefined) continue;
        const isNegativeDelta = previousBalance > currentBalance;
        const hasMaxEb = currentBalance >= MAX_EFFECTIVE_BALANCE_GWEI;
        if (!isNegativeDelta && !hasMaxEb) continue;
        balanceToProve = previousBalance;
      }

      const isProvable = await this.isProvableBalance(keyInfo, balanceToProve);
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

  private getBalanceOrThrow(balances: bigint[], valIndex: string, keysCount: number): bigint {
    const balance = balances[Number(valIndex)];
    if (balance !== undefined) return balance;

    throw new Error(
      `Validator balance is missing for index ${valIndex}. ` +
        `State balances length: ${balances.length}. ` +
        `Keys considered for proving: ${keysCount}.`,
    );
  }

  private async sendGeneralBalanceProofs(
    blockHeader: BlockHeaderResponse,
    state: State,
    balanceChanges: InvolvedKeys,
  ): Promise<IVerifier.ProcessBalanceProofInputStruct[]> {
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(blockHeader.root)).data[0];
    if (!nextHeader) throw new Error(`Next block header after ${blockHeader.root} not found`);
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
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(recentHeader.root)).data[0];
    if (!nextHeader) throw new Error(`Next block header after ${recentHeader.root} not found`);
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
