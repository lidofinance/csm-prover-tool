import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { type GetContractReturnType, type PublicClient, getContract } from 'viem';

import { exitPenaltiesAbi } from './abi/exit-penalties.js';
import { StrikesContract } from './strikes-contract.service.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

@Injectable()
export class ExitPenaltiesContract {
  private contract: GetContractReturnType<typeof exitPenaltiesAbi, PublicClient>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly strikes: StrikesContract,
  ) {}

  public async init() {
    let address = this.config.get('EXIT_PENALTIES_ADDRESS');
    if (!address) {
      this.logger.warn(
        'EXIT_PENALTIES_ADDRESS env variable is not specified. Trying to get address from CSStrikes contract...',
      );
      address = await this.strikes.getExitPenaltiesAddress();
    }
    this.logger.log(`CSExitPenalties address: ${address}`);
    this.contract = getContract({ address, abi: exitPenaltiesAbi, client: this.execution.client });
  }

  public async isEjectionProved(keyInfo: KeyInfo, blockNumber: bigint): Promise<boolean> {
    const data = await this.contract.read.getExitPenaltyInfo([BigInt(keyInfo.operatorId), keyInfo.pubKey], {
      blockNumber,
    });
    return data.strikesPenalty.isValue;
  }
}
