import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import type { RootHex } from '@lodestar/types';
import { Inject, Injectable } from '@nestjs/common';

import type { AppLogger } from '../logger/app-logger.type.js';
import { BadPerformersService } from './duties/bad-performers.service.js';
import { ConsolidationsService } from './duties/consolidations.service.js';
import { SlashingsService } from './duties/slashings.service.js';
import { WithdrawalsService } from './duties/withdrawals.service.js';
import { FullKeyInfoByPubKeyFn, KeyInfoFn } from './types.js';
import { toRootHex } from '../helpers/proofs.js';
import { Consensus } from '../providers/consensus/consensus.js';
import type { SupportedBlock } from '../providers/consensus/forks.js';
import type { BlockHeaderResponse } from '../providers/consensus/response.interface.js';

@Injectable()
export class ProverService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly consensus: Consensus,
    protected readonly withdrawals: WithdrawalsService,
    protected readonly strikes: BadPerformersService,
    protected readonly slashings: SlashingsService,
    protected readonly consolidations: ConsolidationsService,
  ) {}

  public async handleWithdrawalsInBlock(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    const toProve = await this.withdrawals.getUnprovenWithdrawals(blockInfo, keyInfoFn);
    const sentCount = await this.withdrawals.sendWithdrawalProofs(blockRoot, blockInfo, finalizedHeader, toProve);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Withdrawal Proof(s) were sent`);
    } else {
      this.logger.log('No Withdrawal Proof(s) were sent');
    }
  }

  public async handleBadPerformers(
    headHeader: BlockHeaderResponse,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<void> {
    const headBlockInfo = await this.consensus.getBlockInfo(headHeader.root);
    const toProve = await this.strikes.getUnprovenNonWithdrawnBadPerformers(headBlockInfo, fullKeyInfoFn);
    const sentCount = await this.strikes.sendBadPerformanceProofs(toProve);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Bad performer Proof(s) were sent`);
    } else {
      this.logger.log('No Bad performer Proof(s) were sent');
    }
  }

  public async handleSlashingsInBlock(
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    const slashings = await this.slashings.getUnprovenSlashings(blockInfo, keyInfoFn);
    const sentCount = await this.slashings.sendSlashingProofs(finalizedHeader, slashings);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Slashing proof(s) sent`);
    } else {
      this.logger.log('No slashing proof(s) were sent');
    }
  }

  public async handlePendingConsolidationsInEpoch(
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    const isFirstBlockInEpoch = await this.isFirstBlockInEpoch(blockInfo);
    if (!isFirstBlockInEpoch) {
      this.logger.log('Skipping pending consolidations handling. Not the first block in epoch');
      return;
    }
    const consolidations = await this.consolidations.getConsolidationsToProve(blockInfo, keyInfoFn);
    const sentCount = await this.consolidations.sendConsolidationProofs(finalizedHeader, consolidations);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Consolidation proof(s) sent`);
    } else {
      this.logger.log('No consolidation proof(s) were sent');
    }
  }

  private async isFirstBlockInEpoch(blockInfo: SupportedBlock): Promise<boolean> {
    const currentSlot = Number(blockInfo.slot);
    if (currentSlot === 0) return true;
    const parentRoot = toRootHex(blockInfo.parentRoot);
    const parentHeader = await this.consensus.getBeaconHeader(parentRoot);
    const parentEpoch = this.consensus.slotToEpoch(Number(parentHeader.header.message.slot));
    const currentEpoch = this.consensus.slotToEpoch(currentSlot);
    return parentEpoch < currentEpoch;
  }
}
