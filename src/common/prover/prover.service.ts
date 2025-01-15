import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { WithdrawalsService } from './duties/withdrawals.service';
import { KeyInfoFn } from './types';
import { Consensus, SupportedBlock } from '../providers/consensus/consensus';
import { BlockHeaderResponse, RootHex } from '../providers/consensus/response.interface';

@Injectable()
export class ProverService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly withdrawals: WithdrawalsService,
  ) {}

  public async handleBlock(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    await this.handleWithdrawalsInBlock(blockRoot, blockInfo, finalizedHeader, keyInfoFn);
  }

  public async handleWithdrawalsInBlock(
    blockRoot: RootHex,
    blockInfo: SupportedBlock,
    finalizedHeader: BlockHeaderResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    const withdrawals = await this.withdrawals.getUnprovenWithdrawals(blockInfo, keyInfoFn);
    if (!Object.keys(withdrawals).length) {
      this.logger.log('No withdrawals to prove');
      return;
    }
    await this.withdrawals.sendWithdrawalProofs(blockRoot, blockInfo, finalizedHeader, withdrawals);
    this.logger.log('🏁 Withdrawal proof(s) sent');
  }
}
