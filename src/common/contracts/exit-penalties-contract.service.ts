import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { StrikesContract } from './strikes-contract.service';
import { ExitPenalties, ExitPenalties__factory } from './types';
import { ConfigService } from '../config/config.service';
import { KeyInfo } from '../prover/types';
import { Execution } from '../providers/execution/execution';

@Injectable()
export class ExitPenaltiesContract {
  private impl: ExitPenalties;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly strikes: StrikesContract,
  ) {}

  // TODO: Move to onModuleInit after Mainnet release. Needed only for v1 -> v2 smooth transition
  public async init() {
    let address = this.config.get('EXIT_PENALTIES_ADDRESS');
    if (!address || address == '') {
      this.logger.warn(
        'EXIT_PENALTIES_ADDRESS env variable is not specified. Trying to get address from CSStrikes contract...',
      );
      address = await this.strikes.getExitPenaltiesAddress();
    }
    this.logger.log(`CSExitPenalties address: ${address}`);
    this.impl = ExitPenalties__factory.connect(address, this.execution.provider);
  }

  public async isEjectionProved(keyInfo: KeyInfo): Promise<boolean> {
    return (await this.impl.getExitPenaltyInfo(keyInfo.operatorId, keyInfo.pubKey)).strikesPenalty.isValue;
  }
}
