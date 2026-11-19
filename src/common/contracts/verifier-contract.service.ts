import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import {
  type GetContractReturnType,
  type PublicClient,
  getAbiItem,
  getContract,
  isAddress,
  toFunctionSelector,
} from 'viem';

import { curatedVerifierAbi } from './abi/curated-verifier.js';
import { verifierAbi } from './abi/verifier.js';
import { StakingModuleContract } from './staking-module-contract.service.js';
import type * as ICuratedVerifier from './structs/curated-verifier.js';
import type * as IVerifier from './structs/verifier.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { findContractRevert } from '../providers/execution/execution-client.js';
import { Execution } from '../providers/execution/execution.js';

type Verifier = GetContractReturnType<typeof verifierAbi, PublicClient>;
type CuratedVerifier = GetContractReturnType<typeof curatedVerifierAbi, PublicClient>;

@Injectable()
export class VerifierContract {
  private contract: Verifier;
  private curatedContract: CuratedVerifier;
  public isCurated = false;
  private minWithdrawalRatio?: bigint; // immutable in the contract

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
    protected readonly stakingModule: StakingModuleContract,
  ) {}

  public async init() {
    let address = this.config.get('VERIFIER_ADDRESS');
    if (!address || address == '') {
      this.logger.warn(
        'VERIFIER_ADDRESS env variable is not specified. Trying to get role member from staking module contract...',
      );
      const verifierRoleMembers = await this.stakingModule.getVerifierRoleMembers();
      if (verifierRoleMembers.length == 0) {
        throw new Error('No one member for VERIFIER_ROLE were found');
      }
      if (verifierRoleMembers.length > 1) {
        throw new Error(
          'You must specify `VERIFIER_ADDRESS` env. More than one `VERIFIER_ROLE` role member were found: ' +
            verifierRoleMembers,
        );
      }
      address = verifierRoleMembers[0];
    }
    if (!isAddress(address)) {
      throw new Error(`Invalid VERIFIER_ADDRESS: ${address}`);
    }
    this.contract = getContract({ address, abi: verifierAbi, client: this.execution.client });
    this.curatedContract = getContract({ address, abi: curatedVerifierAbi, client: this.execution.client });

    // Only the CuratedVerifier dispatches processWithdrawnProof; solc pushes each dispatched selector with PUSH4 (0x63)
    const selector = toFunctionSelector(getAbiItem({ abi: curatedVerifierAbi, name: 'processWithdrawnProof' }));
    const code = await this.execution.client.getCode({ address });
    this.isCurated = code?.includes(`63${selector.slice(2)}`) ?? false;
    this.logger.log(`CSVerifier address: ${address} (${this.isCurated ? 'CuratedVerifier' : 'Verifier'})`);

    let isPaused = false;
    try {
      isPaused = await this.isPaused();
    } catch (e) {
      if (findContractRevert(e)) {
        this.logger.warn(`CSVerifier ${address} does not support isPaused() method yet, assuming it is not paused`);
      } else {
        throw e;
      }
    }
    if (isPaused) {
      throw new Error(`CSVerifier ${address} is paused`);
    }
  }

  public async sendSlashingProof(payload: IVerifier.ProcessSlashedInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.contract.address,
      abi: verifierAbi,
      functionName: 'processSlashedProof',
      args: [payload],
    });
  }

  public async sendWithdrawnProof(payload: ICuratedVerifier.ProcessWithdrawnInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.curatedContract.address,
      abi: curatedVerifierAbi,
      functionName: 'processWithdrawnProof',
      args: [payload],
    });
  }

  public async sendWithdrawalProof(payload: IVerifier.ProcessWithdrawalInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.contract.address,
      abi: verifierAbi,
      functionName: 'processWithdrawalProof',
      args: [payload],
    });
  }

  public async sendHistoricalWithdrawalProof(payload: IVerifier.ProcessHistoricalWithdrawalInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.contract.address,
      abi: verifierAbi,
      functionName: 'processHistoricalWithdrawalProof',
      args: [payload],
    });
  }

  public async sendBalanceProof(payload: IVerifier.ProcessBalanceProofInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.contract.address,
      abi: verifierAbi,
      functionName: 'processBalanceProof',
      args: [payload],
    });
  }

  public async sendHistoricalBalanceProof(payload: IVerifier.ProcessHistoricalBalanceProofInputStruct): Promise<void> {
    await this.execution.execute({
      address: this.contract.address,
      abi: verifierAbi,
      functionName: 'processHistoricalBalanceProof',
      args: [payload],
    });
  }

  public async isPaused(): Promise<boolean> {
    return await this.contract.read.isPaused();
  }

  public async getMinWithdrawalRatio(): Promise<bigint> {
    this.minWithdrawalRatio ??= await this.contract.read.MIN_WITHDRAWAL_RATIO();
    return this.minWithdrawalRatio;
  }
}
