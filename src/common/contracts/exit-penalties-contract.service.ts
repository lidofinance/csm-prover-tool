import { type BlockTag } from '@ethersproject/abstract-provider';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { StrikesContract } from './strikes-contract.service.js';
import { type ExitPenalties, ExitPenalties__factory } from './types/index.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

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
    this.logger.log(`CSExitPenalties address: ${address}`);
    this.contract = ExitPenalties__factory.connect(address, this.execution.provider);
  }

  public async isEjectionProved(blockTag: BlockTag, keyInfo: KeyInfo): Promise<boolean> {
    const data = await this.contract.getExitPenaltyInfo(keyInfo.operatorId, keyInfo.pubKey, { blockTag });
    return data.strikesPenalty.isValue;
  }
}
