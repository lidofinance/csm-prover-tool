import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { StakingModuleContract } from '../../contracts/staking-module-contract.service.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus } from '../../providers/consensus/consensus.js';
import type { SupportedBlock } from '../../providers/consensus/forks.js';
import { Execution } from '../../providers/execution/execution.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfo, KeyInfoFn } from '../types.js';

export type InvolvedKeys = { [valIndex: string]: KeyInfo };

@Injectable()
export class SlashingsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly execution: Execution,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenSlashings(blockInfo: SupportedBlock, keyInfoFn: KeyInfoFn): Promise<InvolvedKeys> {
    const slashings = {
      ...this.getSlashedProposers(blockInfo, keyInfoFn),
      ...this.getSlashedAttesters(blockInfo, keyInfoFn),
    };
    if (!Object.keys(slashings).length) return {};
    const entries = Object.entries(slashings);
    const proved = await Promise.all(entries.map(([, keyInfo]) => this.stakingModule.isSlashingProved(keyInfo)));
    const unproven: InvolvedKeys = Object.fromEntries(entries.filter((_, i) => !proved[i]));
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.log('No slashings to prove');
      return {};
    }
    this.logger.warn(`🔍 Unproven slashings: ${unprovenCount}`);
    return unproven;
  }

  public async sendSlashingProofs(slashings: InvolvedKeys): Promise<number> {
    if (!Object.keys(slashings).length) return 0;
    const { root, timestamp } = await this.execution.getFinalizedBeaconAnchor();
    const finalizedHeader = await this.consensus.getBeaconHeader(root);
    const finalizedState = await this.consensus.getState(toRootHex(finalizedHeader.header.message.stateRoot));
    this.logger.log(`Building slashing proof payloads`);
    const payloads = await this.workers.getSlashedProofPayloads({
      currentHeader: finalizedHeader,
      nextHeaderTimestamp: timestamp,
      state: finalizedState,
      slashings: slashings,
    });
    for (const payload of payloads) {
      this.logger.log(`📡 Sending slashing proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendSlashingProof(payload);
    }
    return payloads.length;
  }

  private getSlashedAttesters(
    blockInfo: SupportedBlock,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeys {
    const slashed: InvolvedKeys = {};
    for (const att of blockInfo.body.attesterSlashings) {
      const accused = att.attestation1.attestingIndices.filter((x) => att.attestation2.attestingIndices.includes(x));
      for (const valIndex of accused) {
        const keyInfo = keyInfoFn(Number(valIndex));
        if (!keyInfo) continue;
        slashed[valIndex] = keyInfo;
      }
    }
    return slashed;
  }

  private getSlashedProposers(
    blockInfo: SupportedBlock,
    keyInfoFn: (valIndex: number) => KeyInfo | undefined,
  ): InvolvedKeys {
    const slashed: InvolvedKeys = {};
    for (const prop of blockInfo.body.proposerSlashings) {
      const keyInfo = keyInfoFn(Number(prop.signedHeader1.message.proposerIndex));
      if (!keyInfo) continue;
      slashed[prop.signedHeader1.message.proposerIndex] = keyInfo;
    }
    return slashed;
  }
}
