import { BlockTag } from '@ethersproject/abstract-provider';
import { AddressZero } from '@ethersproject/constants';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { utils } from 'ethers';

import { AccountingContract } from './accounting-contract.service';
import { FeeDistributor__factory, FeeOracle__factory, Strikes, Strikes__factory } from './types';
import { ConfigService } from '../config/config.service';
import { BadPerformerProofPayload } from '../prover/types';
import { Execution } from '../providers/execution/execution';

const WITHDRAWAL_REQUEST_SYS_ADDRESS = '0x00000961Ef480Eb55e80D19ad83579A64c007002';

@Injectable()
export class StrikesContract {
  private contract: Strikes;

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
      const feeDistributorContract = FeeDistributor__factory.connect(feeDistributor, this.execution.provider);
      const feeOracle = await feeDistributorContract.ORACLE();
      const feeOracleContract = FeeOracle__factory.connect(feeOracle, this.execution.provider);
      address = await feeOracleContract.STRIKES();
    }
    this.logger.log(`CSStrikes address: ${address}`);
    this.contract = Strikes__factory.connect(address, this.execution.provider);
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
    const singleWithdrawalFee = await this.getRequestFee(WITHDRAWAL_REQUEST_SYS_ADDRESS);
    const withdrawalFee = BigInt(payload.keyStrikesList.length) * singleWithdrawalFee;
    this.logger.log(
      `Sending bad performance proof for ${payload.keyStrikesList.length} keys with total fee: ${utils.formatUnits(withdrawalFee, 'gwei')} Gwei`,
    );
    await this.execution.execute(
      this.contract.callStatic.processBadPerformanceProof,
      this.contract.populateTransaction.processBadPerformanceProof,
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

  public async getExitPenaltiesAddress(): Promise<string> {
    return await this.contract.EXIT_PENALTIES();
  }

  public async getTreeCid(blockTag: BlockTag): Promise<string> {
    return await this.contract.treeCid({ blockTag });
  }

  public async getTreeRoot(blockTag: BlockTag): Promise<string> {
    return await this.contract.treeRoot({ blockTag });
  }
}
