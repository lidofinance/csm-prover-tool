import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { utils } from 'ethers';

import { type Csm, Csm__factory } from './types/index.js';
import { ConfigService } from '../config/config.service.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import type { KeyInfo } from '../prover/types.js';
import { Execution } from '../providers/execution/execution.js';

// 8 keys per getSigningKeys call; one aggregate3 holds 170 such calls, i.e. 1,360 keys at ~7.5M gas, well under the eth_call gas cap nodes enforce (geth: 50M)
const KEYS_PER_CALL = 8;
const PUBKEY_BYTES = 48;

export type KeysRange = { operatorId: number; from: number; to: number };

@Injectable()
export class StakingModuleContract {
  private contract: Csm;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly config: ConfigService,
    protected readonly execution: Execution,
  ) {
    const address = this.config.get('STAKING_MODULE_ADDRESS');
    this.logger.log(`Staking module address: ${address}`);
    this.contract = Csm__factory.connect(address, this.execution.provider);
  }

  public async getInitializedVersion(): Promise<number> {
    try {
      return (await this.contract.getInitializedVersion()).toNumber();
    } catch (e) {
      if (e.code === 'CALL_EXCEPTION') {
        return 1;
      }
      throw e;
    }
  }

  public async canProveBalanceChanges(): Promise<boolean> {
    try {
      const topUpQueue = await this.contract.getTopUpQueue();
      return topUpQueue.enabled;
    } catch (e) {
      // TODO: replace this with an explicit module capability/version handler.
      if (e.code !== 'CALL_EXCEPTION' || e.data !== '0x') throw e;
      return true;
    }
  }

  public async getKeyAddedBalances(keyInfos: KeyInfo[]): Promise<bigint[]> {
    // Fetch each operator's candidate keys as one contiguous getKeyConfirmedBalances range
    const operatorIds = [...new Set(keyInfos.map((k) => k.operatorId))];
    const rangeByOperator: Record<number, { start: number; balances: bigint[] }> = {};
    await Promise.all(
      operatorIds.map(async (operatorId) => {
        const keyIndexes = keyInfos.filter((k) => k.operatorId === operatorId).map((k) => k.keyIndex);
        const start = Math.min(...keyIndexes);
        const count = Math.max(...keyIndexes) - start + 1;
        const balances = await this.contract.getKeyConfirmedBalances(operatorId, start, count);
        rangeByOperator[operatorId] = { start, balances: balances.map((b) => b.toBigInt()) };
      }),
    );

    return keyInfos.map(({ operatorId, keyIndex }) => {
      const { start, balances } = rangeByOperator[operatorId];
      return balances[keyIndex - start];
    });
  }

  public async isWithdrawalProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.contract.isValidatorWithdrawn(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async isSlashingProved(keyInfo: KeyInfo): Promise<boolean> {
    return await this.contract.isValidatorSlashed(keyInfo.operatorId, keyInfo.keyIndex);
  }

  public async getNodeOperatorsCount(blockNumber: number): Promise<number> {
    return (await this.contract.getNodeOperatorsCount({ blockTag: blockNumber })).toNumber();
  }

  public async getDepositedKeysCounts(operatorIds: number[], blockNumber: number): Promise<number[]> {
    return await Promise.all(
      operatorIds.map(
        async (operatorId) =>
          (await this.contract.getNodeOperator(operatorId, { blockTag: blockNumber })).totalDepositedKeys,
      ),
    );
  }

  public async getDepositedKeys(ranges: KeysRange[], blockNumber: number): Promise<KeyInfo[]> {
    const chunks: Promise<KeyInfo[]>[] = [];
    for (const { operatorId, from, to } of ranges) {
      for (let start = from; start < to; start += KEYS_PER_CALL) {
        chunks.push(this.getKeysChunk(operatorId, start, Math.min(start + KEYS_PER_CALL, to), blockNumber));
      }
    }
    return (await Promise.all(chunks)).flat();
  }

  private async getKeysChunk(operatorId: number, from: number, to: number, blockNumber: number): Promise<KeyInfo[]> {
    // getSigningKeys returns the pubkeys glued together, 48 bytes each
    const bytes = await this.contract.getSigningKeys(operatorId, from, to - from, { blockTag: blockNumber });
    if (utils.hexDataLength(bytes) !== (to - from) * PUBKEY_BYTES) {
      throw new Error(
        `Unexpected getSigningKeys length for operator ${operatorId} [${from}, ${to}): ${utils.hexDataLength(bytes)}`,
      );
    }
    const keys: KeyInfo[] = [];
    for (let keyIndex = from; keyIndex < to; keyIndex++) {
      const offset = (keyIndex - from) * PUBKEY_BYTES;
      keys.push({
        operatorId,
        keyIndex,
        pubKey: utils.hexDataSlice(bytes, offset, offset + PUBKEY_BYTES).toLowerCase(),
      });
    }
    return keys;
  }

  public async getNodeOperatorKey(nodeOperatorId: string | number, keyIndex: string | number): Promise<string> {
    return await this.contract.getSigningKeys(nodeOperatorId, keyIndex, 1);
  }

  public async getAccountingAddress(): Promise<string> {
    return await this.contract.ACCOUNTING();
  }

  public async getParamsAddress(): Promise<string> {
    return await this.contract.PARAMETERS_REGISTRY();
  }

  public async getVerifierRoleMembers(): Promise<string[]> {
    const members: string[] = [];
    const role = await this.contract.VERIFIER_ROLE();
    const membersCount = (await this.contract.getRoleMemberCount(role)).toNumber();
    for (let i = 0; i < membersCount; i++) {
      const address = await this.contract.getRoleMember(role, i);
      members.push(address);
    }
    return members;
  }
}
