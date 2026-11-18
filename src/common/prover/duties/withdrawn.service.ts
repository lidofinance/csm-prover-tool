import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';

import { StakingModuleContract } from '../../contracts/staking-module-contract.service.js';
import { VerifierContract } from '../../contracts/verifier-contract.service.js';
import { toRootHex } from '../../helpers/proofs.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { Consensus, type State } from '../../providers/consensus/consensus.js';
import { type BlockHeaderResponse, firstCanonical } from '../../providers/consensus/response.interface.js';
import { WorkersService } from '../../workers/workers.service.js';
import type { KeyInfo } from '../types.js';

export type InvolvedKeys = { [valIndex: string]: KeyInfo };

@Injectable()
export class WithdrawnService {
  // Reported withdrawn is monotonic on-chain, so a cached positive is never re-read.
  private readonly provenWithdrawn = new Set<string>();

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    protected readonly workers: WorkersService,
    protected readonly consensus: Consensus,
    protected readonly stakingModule: StakingModuleContract,
    protected readonly verifier: VerifierContract,
  ) {}

  public async getUnprovenWithdrawn(state: State, keys: InvolvedKeys): Promise<InvolvedKeys> {
    if (!Object.keys(keys).length) return {};
    const { slot, validators } = await this.workers.getValidatorsInfo({
      state,
      indices: Object.keys(keys).map(Number),
    });
    const stateEpoch = BigInt(this.consensus.slotToEpoch(slot));
    const candidates = Object.entries(keys).filter(([valIndex]) => {
      const info = validators[Number(valIndex)];
      return info !== undefined && !info.slashed && info.withdrawableEpoch <= stateEpoch;
    });
    const toCheck = candidates.filter(([, keyInfo]) => !this.provenWithdrawn.has(keyInfo.pubKey));
    const proved = await Promise.all(toCheck.map(([, keyInfo]) => this.stakingModule.isWithdrawalProved(keyInfo)));
    const unproven: InvolvedKeys = {};
    toCheck.forEach(([valIndex, keyInfo], i) => {
      if (proved[i]) this.provenWithdrawn.add(keyInfo.pubKey);
      else unproven[valIndex] = keyInfo;
    });
    const unprovenCount = Object.keys(unproven).length;
    if (!unprovenCount) {
      this.logger.log(
        `No withdrawn validators to prove (withdrawable: ${candidates.length}, already reported: ${candidates.length})`,
      );
      return {};
    }
    this.logger.warn(
      `🔍 Unproven withdrawn validators: ${unprovenCount} (withdrawable: ${candidates.length}, already reported: ${candidates.length - unprovenCount})`,
    );
    return unproven;
  }

  public async sendWithdrawnProofs(finalizedHeader: BlockHeaderResponse, keys: InvolvedKeys): Promise<number> {
    if (!Object.keys(keys).length) return 0;
    const finalizedState = await this.consensus.getState(toRootHex(finalizedHeader.header.message.stateRoot));
    const nextHeader = firstCanonical((await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data);
    if (!nextHeader) throw new Error(`Next canonical block header after ${finalizedHeader.root} not found`);
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));
    this.logger.log(`Building withdrawn proof payloads`);
    const payloads = await this.workers.getWithdrawnProofPayloads({
      currentHeader: finalizedHeader,
      nextHeaderTimestamp: nextHeaderTs,
      state: finalizedState,
      keys,
      epoch: this.consensus.slotToEpoch(Number(finalizedHeader.header.message.slot)),
    });
    for (const payload of payloads) {
      this.logger.log(`📡 Sending withdrawn proof payload for validator index: ${payload.validator.index}`);
      await this.verifier.sendWithdrawnProof(payload);
    }
    return payloads.length;
  }
}
