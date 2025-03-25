import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { BadPerformersService } from './duties/bad-performers.service';
import { WithdrawalsService } from './duties/withdrawals.service';
import { FullKeyInfoByPubKeyFn, KeyInfoFn } from './types';
import { Consensus, SupportedBlock } from '../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../providers/consensus/response.interface';

@Injectable()
export class ProverService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly withdrawals: WithdrawalsService,
    protected readonly strikes: BadPerformersService,
  ) {}

  public async handleBlock(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<void> {
    await this.handleWithdrawalsInBlock(blockRoot, blockInfo, finalizedHeader, keyInfoFn);
    await this.handleBadPerformersInOracleReport(blockInfo, fullKeyInfoFn);
  }

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

  public async handleBadPerformersInOracleReport(
    blockInfo: SupportedBlock,
    fullKeyInfoFn: FullKeyInfoByPubKeyFn,
  ): Promise<void> {
    const toProve = await this.strikes.getUnprovenNonExitedBadPerformers(blockInfo, fullKeyInfoFn);
    const sentCount = await this.strikes.sendBadPerformanceProofs(toProve);
    if (sentCount > 0) {
      this.logger.log(`🏁 ${sentCount} Bad performer Proof(s) were sent`);
    } else {
      this.logger.log('No Bad performer Proof(s) were sent');
    }
  }
}
