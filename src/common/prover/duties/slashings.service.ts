import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { CsmContract } from '../../contracts/csm-contract.service';
import { VerifierContract } from '../../contracts/verifier-contract.service';
import { Consensus } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, BlockInfoResponse } from '../../providers/consensus/response.interface';
import { WorkersService } from '../../workers/workers.service';
import { KeyInfo, KeyInfoFn } from '../types';

export type InvolvedKeys = { [valIndex: string]: KeyInfo };

@Injectable()
export class SlashingsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly csm: CsmContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenSlashings(blockInfo: BlockInfoResponse, keyInfoFn: KeyInfoFn): Promise<InvolvedKeys> {
    const slashings = {
      ...this.getSlashedProposers(blockInfo, keyInfoFn),
      ...this.getSlashedAttesters(blockInfo, keyInfoFn),
    };
    if (!Object.keys(slashings).length) return {};
    const unproven: InvolvedKeys = {};
    for (const [valIndex, keyInfo] of Object.entries(slashings)) {
      const proved = await this.csm.isSlashingProved(keyInfo);
      if (!proved) unproven[valIndex] = keyInfo;
    }
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.log('No slashings to prove');
      return {};
    }
    this.logger.warn(`🔍 Unproven slashings: ${unprovenCount}`);
    return unproven;
  }

  public async sendSlashingProof(finalizedHeader: BlockHeaderResponse, slashings: InvolvedKeys): Promise<void> {
    if (!Object.keys(slashings).length) return;
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));
    this.logger.log(`Building slashing proof payloads`);
    const payloads = await this.workers.getSlashingProofPayloads({
      currentHeader: finalizedHeader,
      nextHeaderTimestamp: nextHeaderTs,
      state: finalizedState,
      slashings,
    });
    for (const payload of payloads) {
      this.logger.log(`📡 Sending slashing proof payload for validator index: ${payload.witness.validatorIndex}`);
      await this.verifier.sendSlashingProof(payload);
    }
  }

  private getSlashedAttesters(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeys {
    const slashed: InvolvedKeys = {};
    for (const att of blockInfo.message.body.attester_slashings) {
      const accused = att.attestation_1.attesting_indices.filter((x) =>
        att.attestation_2.attesting_indices.includes(x),
      );
      for (const valIndex of accused) {
        const keyInfo = keyInfoFn(Number(valIndex));
        if (!keyInfo) continue;
        slashed[valIndex] = keyInfo;
      }
    }
    return slashed;
  }

  private getSlashedProposers(
    blockInfo: BlockInfoResponse,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeys {
    const slashed: InvolvedKeys = {};
    for (const prop of blockInfo.message.body.proposer_slashings) {
      const keyInfo = keyInfoFn(Number(prop.signed_header_1.proposer_index));
      if (!keyInfo) continue;
      slashed[prop.signed_header_1.proposer_index] = keyInfo;
    }
    return slashed;
  }
}