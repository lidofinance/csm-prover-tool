import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { type GetContractReturnType, type Hex, type PublicClient, getContract, isAddress } from 'viem';

import { exitPenaltiesAbi } from './abi/exit-penalties.js';
import { StrikesContract } from './strikes-contract.service.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

type ExitPenalties = GetContractReturnType<typeof exitPenaltiesAbi, PublicClient>;

@Injectable()
export class ExitPenaltiesContract {
  private contract: ExitPenalties;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly strikes: StrikesContract,
  ) {}

  public async init() {
    let address = this.config.get('EXIT_PENALTIES_ADDRESS');
    if (!address || address == '') {
      this.logger.warn(
        'EXIT_PENALTIES_ADDRESS env variable is not specified. Trying to get address from CSStrikes contract...',
      );
      address = await this.strikes.getExitPenaltiesAddress();
    }
    if (!isAddress(address)) {
      throw new Error(`Invalid EXIT_PENALTIES_ADDRESS: ${address}`);
    }
    this.logger.log(`CSExitPenalties address: ${address}`);
    this.contract = getContract({ address, abi: exitPenaltiesAbi, client: this.execution.client });
  }

  public async isEjectionProved(keyInfo: KeyInfo, blockNumber: number): Promise<boolean> {
    const data = await this.contract.read.getExitPenaltyInfo([BigInt(keyInfo.operatorId), keyInfo.pubKey as Hex], {
      blockNumber: BigInt(blockNumber),
    });
    return data.strikesPenalty.isValue;
  }
}
