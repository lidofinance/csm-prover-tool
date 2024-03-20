import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { SlashingsService } from './duties/slashings';
import { WithdrawalsService } from './duties/withdrawals';
import { KeyInfoFn } from './types';
import { Consensus } from '../providers/consensus/consensus';
import { BlockInfoResponse, RootHex } from '../providers/consensus/response.interface';

@Injectable()
export class ProverService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
    protected readonly withdrawals: WithdrawalsService,
    protected readonly slashings: SlashingsService,
  ) {}

  public async handleBlock(
    blockRoot: RootHex,
    blockInfo: BlockInfoResponse,
    finalizedBlockRoot: RootHex,
    keyInfoFn: KeyInfoFn,
  ): Promise<void> {
    const slashings = await this.slashings.getUnprovenSlashings(blockInfo, keyInfoFn);
    const withdrawals = await this.withdrawals.getUnprovenWithdrawals(blockInfo, keyInfoFn);
    if (!Object.keys(slashings).length && !Object.keys(withdrawals).length) {
      this.logger.log('Nothing to prove');
      return;
    }
    const finalizedHeader = await this.consensus.getBeaconHeader(finalizedBlockRoot);
    // do it consistently because of the high resource usage (both the app and CL node)
    await this.slashings.sendSlashingProves(finalizedHeader, slashings);
    await this.withdrawals.sendWithdrawalProves(blockRoot, blockInfo, finalizedHeader, withdrawals);
    this.logger.log('🏁 Prove(s) sent');
  }
}
