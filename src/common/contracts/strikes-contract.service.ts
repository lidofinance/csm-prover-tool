import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import {
  type Address,
  type GetContractReturnType,
  type PublicClient,
  formatGwei,
  getContract,
  hexToBigInt,
  size,
  zeroAddress,
} from 'viem';

import { ejectorAbi } from './abi/ejector.js';
import { feeDistributorAbi } from './abi/fee-distributor.js';
import { feeOracleAbi } from './abi/fee-oracle.js';
import { strikesAbi } from './abi/strikes.js';
import { triggerableWithdrawalsGatewayAbi } from './abi/triggerable-withdrawals-gateway.js';
import { AccountingContract } from './accounting-contract.service.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { BadPerformerProofPayload } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

const WITHDRAWAL_REQUEST_SYS_ADDRESS = '0x00000961Ef480Eb55e80D19ad83579A64c007002';

@Injectable()
export class StrikesContract {
  private contract: GetContractReturnType<typeof strikesAbi, PublicClient>;
  private gateway: GetContractReturnType<typeof triggerableWithdrawalsGatewayAbi, PublicClient>;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly accounting: AccountingContract,
  ) {}

  public async init() {
    let address = this.config.get('STRIKES_ADDRESS');
    if (!address) {
      this.logger.warn(
        'STRIKES_ADDRESS env variable is not specified. Trying to get address from CSFeeOracle contract...',
      );
      const feeDistributor = await this.accounting.getFeeDistributorAddress();
      const feeDistributorContract = getContract({
        address: feeDistributor,
        abi: feeDistributorAbi,
        client: this.execution.client,
      });
      const feeOracle = await feeDistributorContract.read.ORACLE();
      const feeOracleContract = getContract({ address: feeOracle, abi: feeOracleAbi, client: this.execution.client });
      address = await feeOracleContract.read.STRIKES();
    }
    if (!address) {
      throw new Error('Failed to resolve CSStrikes address');
    }
    this.logger.log(`CSStrikes address: ${address}`);
    this.contract = getContract({ address, abi: strikesAbi, client: this.execution.client });

    // Resolve the triggerable-withdrawals gateway once — addresses (Strikes -> ejector -> gateway) are deployment-constant.
    const ejectorAddress = await this.contract.read.ejector();
    const ejector = getContract({ address: ejectorAddress, abi: ejectorAbi, client: this.execution.client });
    const gatewayAddress = await ejector.read.triggerableWithdrawalsGateway();
    this.gateway = getContract({
      address: gatewayAddress,
      abi: triggerableWithdrawalsGatewayAbi,
      client: this.execution.client,
    });
    this.logger.log(`TriggerableWithdrawalsGateway address: ${gatewayAddress}`);
  }

  private async getRequestFee(): Promise<bigint> {
    const { data } = await this.execution.client.call({
      to: WITHDRAWAL_REQUEST_SYS_ADDRESS,
      data: '0x',
    });
    if (!data || size(data) !== 32) throw new Error('FeeInvalidData');
    // Parse uint256 from the response (wei)
    const fee = hexToBigInt(data);
    const maxFeeGwei = BigInt(this.config.get('STRIKES_MAX_REQUEST_FEE_GWEI'));
    if (fee >= maxFeeGwei * 1_000_000_000n) {
      throw new Error(`Withdrawal request fee too high: ${formatGwei(fee)} Gwei >= ${maxFeeGwei} Gwei`);
    }
    return fee;
  }

  public async sendBadPerformanceProof(payload: BadPerformerProofPayload): Promise<void> {
    const singleWithdrawalFee = await this.getRequestFee();
    const withdrawalFee = BigInt(payload.keyStrikesList.length) * singleWithdrawalFee;
    this.logger.log(
      `Sending bad performance proof for ${payload.keyStrikesList.length} keys with total fee: ${formatGwei(withdrawalFee)} Gwei`,
    );
    await this.execution.execute({
      address: this.contract.address,
      abi: strikesAbi,
      functionName: 'processBadPerformanceProof',
      args: [
        payload.keyStrikesList,
        payload.proof,
        payload.proofFlags,
        zeroAddress, // msg.sender will be used as a refund recipient
      ],
      value: withdrawalFee,
    });
  }

  public async getExitPenaltiesAddress(): Promise<Address> {
    return await this.contract.read.EXIT_PENALTIES();
  }

  // Current triggerable-withdrawals exit-request allowance. Returns type(uint256).max when unset (unlimited).
  public async getCurrentExitRequestsLimit(): Promise<bigint> {
    const [, , , , currentExitRequestsLimit] = await this.gateway.read.getExitRequestLimitFullInfo();
    return currentExitRequestsLimit;
  }

  public async getTreeCid(blockNumber: number): Promise<string> {
    return await this.contract.read.treeCid({ blockNumber: BigInt(blockNumber) });
  }

  public async getTreeRoot(blockNumber: number): Promise<string> {
    return await this.contract.read.treeRoot({ blockNumber: BigInt(blockNumber) });
  }
}
