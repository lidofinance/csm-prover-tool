import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService } from '@nestjs/common';

import { Consensus } from '../../providers/consensus/consensus';
import { BlockHeaderResponse, BlockInfoResponse } from '../../providers/consensus/response.interface';
import { generateValidatorProof, toHex, verifyProof } from '../helpers/proofs';
import { KeyInfo, KeyInfoFn, SlashingProvePayload } from '../types';

let ssz: typeof import('@lodestar/types').ssz;
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;

type InvolvedKeys = { [valIndex: string]: KeyInfo };

@Injectable()
export class SlashingsService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly consensus: Consensus,
  ) {}

  public async getUnprovenSlashings(blockInfo: BlockInfoResponse, keyInfoFn: KeyInfoFn): Promise<InvolvedKeys> {
    const slashings = {
      ...this.getSlashedProposers(blockInfo, keyInfoFn),
      ...this.getSlashedAttesters(blockInfo, keyInfoFn),
    };
    if (!Object.keys(slashings).length) return {};
    const unproven: InvolvedKeys = {};
    for (const [valIndex, keyInfo] of Object.entries(slashings)) {
      // TODO: implement
      //  const proved = await this.execution.isSlashingProved(slashing);
      const proved = false;
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

  public async sendSlashingProves(finalizedHeader: BlockHeaderResponse, slashings: InvolvedKeys): Promise<void> {
    if (!Object.keys(slashings).length) return;
    this.logger.log(`Getting state for root [${finalizedHeader.root}]`);
    const finalizedState = await this.consensus.getState(finalizedHeader.header.message.state_root);
    const nextHeader = (await this.consensus.getBeaconHeadersByParentRoot(finalizedHeader.root)).data[0];
    const nextHeaderTs = this.consensus.slotToTimestamp(Number(nextHeader.header.message.slot));
    const stateView = this.consensus.stateToView(finalizedState.bodyBytes, finalizedState.forkName);
    const payloads = this.buildSlashingsProvePayloads(finalizedHeader, nextHeaderTs, stateView, slashings);
    for (const payload of payloads) {
      this.logger.warn(`📡 Sending slashing prove payload for validator index: ${payload.witness.validatorIndex}`);
      // TODO: implement
      // TODO: ask before sending if CLI
      this.logger.log(payload);
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

  private *buildSlashingsProvePayloads(
    currentHeader: BlockHeaderResponse,
    nextHeaderTimestamp: number,
    stateView: ContainerTreeViewType<typeof anySsz.BeaconState.fields>,
    slashings: InvolvedKeys,
  ): Generator<SlashingProvePayload> {
    for (const [valIndex, keyInfo] of Object.entries(slashings)) {
      const validator = stateView.validators.get(Number(valIndex));
      const validatorProof = generateValidatorProof(stateView, Number(valIndex));
      // verify validator proof
      verifyProof(stateView.hashTreeRoot(), validatorProof.gindex, validatorProof.witnesses, validator.hashTreeRoot());
      yield {
        keyIndex: keyInfo.keyIndex,
        nodeOperatorId: keyInfo.operatorId,
        beaconBlock: {
          header: {
            slot: currentHeader.header.message.slot,
            proposerIndex: Number(currentHeader.header.message.proposer_index),
            parentRoot: currentHeader.header.message.parent_root,
            stateRoot: currentHeader.header.message.state_root,
            bodyRoot: currentHeader.header.message.body_root,
          },
          rootsTimestamp: nextHeaderTimestamp,
        },
        witness: {
          validatorIndex: Number(valIndex),
          withdrawalCredentials: toHex(validator.withdrawalCredentials),
          effectiveBalance: validator.effectiveBalance,
          activationEligibilityEpoch: validator.activationEligibilityEpoch,
          activationEpoch: validator.activationEpoch,
          exitEpoch: validator.exitEpoch,
          withdrawableEpoch: validator.withdrawableEpoch,
          validatorProof: validatorProof.witnesses.map(toHex),
        },
      };
    }
  }
}
