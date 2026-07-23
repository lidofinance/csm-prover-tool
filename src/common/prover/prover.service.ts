import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { type AppLogger } from '../logger/app-logger.type.js';
import { BadPerformersService } from './duties/bad-performers.service.js';
import { BalancesService, type InvolvedKeys } from './duties/balances.service.js';
import { SlashingsService } from './duties/slashings.service.js';
import { WithdrawalsService } from './duties/withdrawals.service.js';
import type { FullKeyInfoByPubKeyFn, KeyInfoFn } from './types.js';
import { toRootHex } from '../helpers/proofs.js';
import { Consensus } from '../providers/consensus/consensus.js';
import type { SupportedBlock } from '../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../providers/consensus/response.interface.js';

@Injectable()
export class ProverService implements OnModuleInit {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly consensus: Consensus,
    protected readonly withdrawals: WithdrawalsService,
    protected readonly strikes: BadPerformersService,
    protected readonly slashings: SlashingsService,
    protected readonly balances?: BalancesService,
  ) {}

  public onModuleInit(): void {
    if (!this.balances) {
      this.logger.warn('Balance change proving is not supported for this module — balance reporting off');
    }
  }

  public async handleBadPerformers(
    finalizedHeader: BlockHeaderResponse,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<number> {
    if ((await this.strikes.getCurrentExitRequestsLimit()) === 0n) {
      this.logger.warn('⚠️ Exit request limit is 0; skipping bad performers processing this round');
      return 0;
    }
    const finalizedBlockInfo = await this.consensus.getBlockInfo(finalizedHeader.root);
    const badPerformers = await this.strikes.getUnprovenNonWithdrawnBadPerformers(finalizedBlockInfo, fullKeyInfoFn);
    const sentCount = await this.strikes.sendBadPerformanceProofs(badPerformers);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Bad performer Proof(s) were sent`);
    } else {
      this.logger.log('No Bad performer Proof(s) were sent');
    }
    return sentCount;
  }

  public async handleSlashingsInBlock(
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<number> {
    const slashings = await this.slashings.getUnprovenSlashings(blockInfo, keyInfoFn);
    let balanceSentCount = 0;
    if (this.balances && Object.keys(slashings).length > 0) {
      const parentRoot = toRootHex(blockInfo.parentRoot);
      this.logger.log(
        `Parent block [${parentRoot}] will be processed for possible balance increases before proving slashings`,
      );
      const parentHeader = await this.consensus.getBeaconHeader(parentRoot);
      balanceSentCount = await this.handleBalanceChanges(parentHeader, finalizedHeader, () => slashings);
    }
    const sentCount = await this.slashings.sendSlashingProofs(finalizedHeader, slashings);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Slashing proof(s) sent`);
    } else {
      this.logger.log('No slashing proof(s) were sent');
    }
    return sentCount + balanceSentCount;
  }

  public async handleWithdrawalsInBlock(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<number> {
    const withdrawals = await this.withdrawals.getUnprovenWithdrawals(blockRoot, blockInfo, keyInfoFn);
    if (!Object.keys(withdrawals).length) {
      this.logger.log('No Withdrawal Proof(s) were sent');
      return 0;
    }
    const blockHeader = await this.consensus.getBeaconHeader(blockRoot);
    const state = await this.consensus.getState(toRootHex(blockHeader.header.message.stateRoot));
    let balanceSentCount = 0;
    if (this.balances) {
      const parentRoot = toRootHex(blockInfo.parentRoot);
      this.logger.log(
        `Parent block [${parentRoot}] will be processed for possible balance increases before proving withdrawals`,
      );
      const parentHeader = await this.consensus.getBeaconHeader(parentRoot);
      balanceSentCount = await this.handleBalanceChanges(parentHeader, finalizedHeader, () => withdrawals);
    }
    const sentCount = await this.withdrawals.sendWithdrawalProofs(
      blockHeader,
      blockInfo,
      state,
      finalizedHeader,
      withdrawals,
    );
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Withdrawal Proof(s) were sent`);
    } else {
      this.logger.log('No Withdrawal Proof(s) were sent');
    }
    return sentCount + balanceSentCount;
  }

  public async handleBalanceChangesInBlock(
    blockRoot: RootHex,
    finalizedHeader: BlockHeaderResponse,
    getKeys: () => InvolvedKeys,
  ): Promise<number> {
    if (!this.balances) return 0;
    const blockHeader = await this.consensus.getBeaconHeader(blockRoot);
    return await this.handleBalanceChanges(blockHeader, finalizedHeader, getKeys);
  }

  private async handleBalanceChanges(
    blockHeader: BlockHeaderResponse,
    finalizedHeader: BlockHeaderResponse,
    getKeys: () => InvolvedKeys,
  ): Promise<number> {
    if (!this.balances) return 0;

    const keyMap = getKeys();
    if (!Object.keys(keyMap).length) {
      this.logger.log('No keys for balance change proving');
      return 0;
    }

    const currentState = await this.consensus.getState(toRootHex(blockHeader.header.message.stateRoot));
    const balanceChanges = await this.balances.getUnprovenBalanceChangeProofs(currentState, keyMap);
    const sentCount = await this.balances.sendBalanceChangeProofs(
      blockHeader,
      finalizedHeader,
      currentState,
      balanceChanges,
    );

    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Balance change proof(s) sent`);
    } else {
      this.logger.log('No balance change proof(s) were sent');
    }
    return sentCount;
  }
}
