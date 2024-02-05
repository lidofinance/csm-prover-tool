import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { BlockInfoResponse, RootHex } from '../providers/consensus/response.interface';

export interface KeyInfo {
  operatorId: number;
  keyIndex: number;
  pubKey: string;
  withdrawableEpoch: number;
}

type KeyInfoFn = (valIndex: number) => KeyInfo | undefined;

@Injectable()
export class HandlersService {
  constructor(@Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService) {}

  public async prove(blockRoot: RootHex, blockInfo: BlockInfoResponse, keyInfoFn: KeyInfoFn): Promise<void> {
    const slashings = await this.getUnprovenSlashings(blockRoot, blockInfo, keyInfoFn);
    const withdrawals = await this.getUnprovenWithdrawals(blockRoot, blockInfo, keyInfoFn);
    if (!slashings.length && !withdrawals.length) return;
    const payload = await this.buildProvePayload(slashings, withdrawals);
    // TODO: ask before sending if CLI or daemon in watch mode
    await this.sendProves(payload);
  }

  private async buildProvePayload(slashings: string[], withdrawals: string[]): Promise<any> {
    // TODO: implement
    //  this.consensus.getState(...)
    return {};
  }
  private async sendProves(payload: any): Promise<void> {
    // TODO: implement
  }

  private async getUnprovenSlashings(
    blockRoot: RootHex,
    blockInfo: BlockInfoResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<string[]> {
    const slashings = [
      ...this.getSlashedProposers(blockInfo, keyInfoFn),
      ...this.getSlashedAttesters(blockInfo, keyInfoFn),
    ];
    if (!slashings.length) return [];
    const unproven = [];
    for (const slashing of slashings) {
      // TODO: implement
      //  const proved = await this.execution.isSlashingProved(slashing);
      const proved = false;
      if (!proved) unproven.push(slashing);
    }
    if (!unproven.length) {
      this.logger.log(`No slashings to prove. Root [${blockRoot}]`);
      return [];
    }
    this.logger.warn(`🔍 Unproven slashings: ${unproven}`);
    return unproven;
  }

  private async getUnprovenWithdrawals(
    blockRoot: RootHex,
    blockInfo: BlockInfoResponse,
    keyInfoFn: KeyInfoFn,
  ): Promise<string[]> {
    const withdrawals = this.getFullWithdrawals(blockInfo, keyInfoFn);
    if (!withdrawals.length) return [];
    const unproven = [];
    for (const withdrawal of withdrawals) {
      // TODO: implement
      //  const proved = await this.execution.isSlashingProved(slashing);
      const proved = false;
      if (!proved) unproven.push(withdrawal);
    }
    if (!unproven.length) {
      this.logger.log(`No full withdrawals to prove. Root [${blockRoot}]`);
      return [];
    }
    this.logger.warn(`🔍 Unproven full withdrawals: ${unproven}`);
    return unproven;
  }

  private getSlashedAttesters(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): string[] {
    const slashed = [];
    for (const att of blockInfo.message.body.attester_slashings) {
      const accused = att.attestation_1.attesting_indices.filter((x) =>
        att.attestation_2.attesting_indices.includes(x),
      );
      slashed.push(...accused.filter((item) => keyInfoFn(Number(item))));
    }
    return slashed;
  }

  private getSlashedProposers(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): string[] {
    const slashed = [];
    for (const prop of blockInfo.message.body.proposer_slashings) {
      if (keyInfoFn(Number(prop.signed_header_1.proposer_index))) {
        slashed.push(prop.signed_header_1.proposer_index);
      }
    }
    return slashed;
  }

  private getFullWithdrawals(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): string[] {
    const fullWithdrawals = [];
    const blockEpoch = Number(blockInfo.message.slot) / 32;
    const withdrawals = blockInfo.message.body.execution_payload.withdrawals;
    for (const withdrawal of withdrawals) {
      const keyInfo = keyInfoFn(Number(withdrawal.validator_index));
      if (keyInfo && blockEpoch >= keyInfo.withdrawableEpoch) {
        fullWithdrawals.push(withdrawal.validator_index);
      }
    }
    return fullWithdrawals;
  }
}
