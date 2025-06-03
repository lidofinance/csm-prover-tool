import { Result } from '@ethersproject/abi';
import { AddressZero } from '@ethersproject/constants';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { Contract, utils } from 'ethers';

import { AccountingContract } from './accounting-contract.service';
import { Strikes, Strikes__factory } from './types';
import { ConfigService } from '../config/config.service';
import { BadPerformerProofPayload } from '../prover/types';
import { Execution } from '../providers/execution/execution';

const WITHDRAWAL_REQUEST_SYS_ADDRESS = '0x00000961Ef480Eb55e80D19ad83579A64c007002';

@Injectable()
export class StrikesContract {
  public impl: Strikes;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly accounting: AccountingContract,
  ) {}

  // TODO: Move to onModuleInit after Mainnet release. Needed only for v1 -> v2 smooth transition
  public async init() {
    let address = this.config.get('STRIKES_ADDRESS');
    if (!address || address == '') {
      this.logger.warn(
        'STRIKES_ADDRESS env variable is not specified. Trying to get address from CSFeeOracle contract...',
      );
      const feeDistributor = await this.accounting.getFeeDistributorAddress();
      // Bypass useless type-chaining here and get it using pure ethers
      const feeDistributorContract = new Contract(
        feeDistributor,
        ['function ORACLE() view returns (address)'],
        this.execution.provider,
      );
      const feeOracle = await feeDistributorContract.ORACLE();
      const feeOracleContract = new Contract(
        feeOracle,
        ['function STRIKES() view returns (address)'],
        this.execution.provider,
      );
      address = await feeOracleContract.STRIKES();
    }
    this.logger.log(`CSStrikes address: ${address}`);
    this.impl = Strikes__factory.connect(address, this.execution.provider);
  }

  private async getRequestFee(requestedContract: string): Promise<bigint> {
    const result = await this.execution.provider.call({
      to: requestedContract,
      data: '0x',
    });

    if (!result.startsWith('0x')) {
      throw new Error('FeeReadFailed');
    }

    // Remove '0x' prefix for length check
    if (result.slice(2).length !== 64) {
      // 32 bytes = 64 hex chars
      throw new Error('FeeInvalidData');
    }

    // Parse uint256 from the response
    return BigInt(result);
  }

  public async sendBadPerformanceProof(payload: BadPerformerProofPayload): Promise<void> {
    // TODO: getWithdrawalRequestFee from WITHDRAWALS_VAULT
    // TODO: getMaxWithdrawalRequestFee from params ?
    const singleWithdrawalFee = await this.getRequestFee(WITHDRAWAL_REQUEST_SYS_ADDRESS);
    const withdrawalFee = BigInt(payload.keyStrikesList.length) * singleWithdrawalFee;
    this.logger.log(
      `Sending bad performance proof for ${payload.keyStrikesList.length} keys with total fee: ${utils.formatUnits(withdrawalFee, 'gwei')} Gwei`,
    );
    await this.execution.execute(
      this.impl.callStatic.processBadPerformanceProof,
      this.impl.populateTransaction.processBadPerformanceProof,
      [
        payload.keyStrikesList,
        payload.proof,
        payload.proofFlags,
        AddressZero, // msg.sender will be used as a refund recipient
        {
          value: withdrawalFee,
        },
      ],
    );
  }

  public async findStrikesReportEventInBlock(blockHash: string): Promise<Result | undefined> {
    const strikesDataUpdatedEvent = this.impl.interface.getEvent('StrikesDataUpdated');
    const logs = await this.execution.provider.getLogs({
      blockHash,
      address: this.impl.address,
      topics: [this.impl.interface.getEventTopic(strikesDataUpdatedEvent)],
    });
    if (logs.length == 0) return undefined;
    if (logs.length > 1) {
      throw new Error(
        `Unexpected count (${logs.length}) of ${strikesDataUpdatedEvent.name} event in the block. Should be only 1`,
      );
    }
    this.logger.log(`🎳 ${strikesDataUpdatedEvent.name} event was found in the block`);
    return this.impl.interface.decodeEventLog(strikesDataUpdatedEvent, logs[0].data);
  }

  public async getExitPenaltiesAddress(): Promise<string> {
    return await this.impl.EXIT_PENALTIES();
  }
}
