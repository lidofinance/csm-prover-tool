import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject } from '@nestjs/common';
import { Command as Commander } from 'commander';
import { Command, CommandRunner, InjectCommander, InquirerService, Option } from 'nest-commander';

import { ConfigService } from '../../common/config/config.service.js';
import { CsmContract } from '../../common/contracts/csm-contract.service.js';
import { type AppLogger } from '../../common/logger/app-logger.type.js';
import { ProverService } from '../../common/prover/prover.service.js';
import type { FullKeyInfoByPubKeyFn, KeyInfoFn } from '../../common/prover/types.js';
import { Consensus } from '../../common/providers/consensus/consensus.js';
import {
  PROOF_TYPES,
  validateClBlock,
  validateKeyIndex,
  validateNodeOperatorId,
  validateValidatorIndex,
} from '../questions/proof-input.question.js';
import type { ProofType } from '../questions/proof-input.question.js';

type ProofOptions = {
  nodeOperatorId: string;
  keyIndex: string;
  validatorIndex: string;
  clBlock?: string;
  proofType?: ProofType;
};

@Command({
  name: 'prove',
  description: 'Prove a slashing or withdrawal or bad performer or balance change',
  arguments: '<slashing|withdrawal|bad_performer|balance>',
  argsDescription: {
    withdrawal: 'Prove a withdrawal',
    bad_performer: 'Prove a bad performer',
    slashing: 'Prove a slashing',
    balance: 'Prove a balance change',
  },
})
export class ProveCommand extends CommandRunner {
  private options: ProofOptions;
  private pubkey: string;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    @InjectCommander() private readonly commander: Commander,
    protected readonly inquirerService: InquirerService,
    protected readonly config: ConfigService,
    protected readonly csm: CsmContract,
    protected readonly consensus: Consensus,
    protected readonly prover: ProverService,
  ) {
    super();
  }

  async run(inputs: string[], options?: Partial<ProofOptions>) {
    const startedAt = Date.now();
    try {
      const proofType = this.getProofTypeOrThrow(inputs[0]);
      this.options = await this.inquirerService.ask('proof-input', { ...options, proofType });
      this.logger.debug!(this.options);

      this.pubkey = await this.csm.getNodeOperatorKey(this.options.nodeOperatorId, this.options.keyIndex);
      this.logger.debug!(`Validator public key: ${this.pubkey}`);

      const finalizedHeader = await this.consensus.getBeaconHeader('finalized');
      this.logPreflightSummary(proofType, finalizedHeader.root, Number(finalizedHeader.header.message.slot));

      let sentCount = 0;

      switch (proofType) {
        case 'withdrawal':
          this.ensureClBlock(this.options.clBlock);
          const withdrawalBlockInfo = await this.consensus.getBlockInfo(this.options.clBlock);
          const { root: withdrawalBlockRoot } = await this.consensus.getBeaconHeader(this.options.clBlock);
          sentCount = await this.prover.handleWithdrawalsInBlock(
            withdrawalBlockRoot,
            withdrawalBlockInfo,
            finalizedHeader,
            this.keyInfoFn,
          );
          break;
        case 'bad_performer':
          const headHeader = await this.consensus.getBeaconHeader('head');
          sentCount = await this.prover.handleBadPerformers(headHeader, this.fullKeyInfoFn);
          break;
        case 'slashing':
          this.ensureClBlock(this.options.clBlock);
          const slashingBlockInfo = await this.consensus.getBlockInfo(this.options.clBlock);
          sentCount = await this.prover.handleSlashingsInBlock(slashingBlockInfo, finalizedHeader, this.keyInfoFn);
          break;
        case 'balance':
          this.ensureClBlock(this.options.clBlock);
          const { root: balanceBlockRoot } = await this.consensus.getBeaconHeader(this.options.clBlock);
          sentCount = await this.prover.handleBalanceChangesInBlock(balanceBlockRoot, finalizedHeader, () => ({
            [this.options.validatorIndex]: this.getSelectedKeyInfo(),
          }));
          break;
      }

      const elapsedMs = Date.now() - startedAt;
      if (sentCount > 0) {
        this.logger.log(`SUCCESS: sent ${sentCount} proof(s) for mode "${proofType}" in ${elapsedMs}ms`);
      } else {
        this.logger.log(`NOOP: no proofs were sent for mode "${proofType}" (${elapsedMs}ms)`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.commander.error(`CLI proving failed: ${message}`);
    }
  }

  @Option({
    flags: '--node-operator-id <nodeOperatorId>',
    description: 'Node Operator ID from the CSM',
  })
  parseNodeOperatorId(val: string) {
    return validateNodeOperatorId(val);
  }

  @Option({
    flags: '--key-index <keyIndex>',
    description: 'Key Index from the CSM',
  })
  parseKeyIndex(val: string) {
    return validateKeyIndex(val);
  }

  @Option({
    flags: '--validator-index <validatorIndex>',
    description: 'Validator Index from the Consensus Layer',
  })
  parseValidatorIndex(val: string) {
    return validateValidatorIndex(val);
  }

  @Option({
    flags: '--cl-block <clBlock>',
    description: 'Block from the Consensus Layer (slot number or block root)',
  })
  parseClBlock(val: string) {
    return validateClBlock(val);
  }

  private getProofTypeOrThrow(input: string | undefined): ProofType {
    if (!input || !PROOF_TYPES.includes(input as ProofType)) {
      throw new Error(`Unknown proof type "${input ?? ''}". Expected one of: ${PROOF_TYPES.join(', ')}`);
    }
    return input as ProofType;
  }

  private ensureClBlock(clBlock: string | undefined): asserts clBlock is string {
    if (!clBlock) {
      throw new Error('--cl-block is required for this proof mode');
    }
  }

  private getSelectedKeyInfo() {
    return {
      operatorId: Number(this.options.nodeOperatorId),
      keyIndex: Number(this.options.keyIndex),
      pubKey: this.pubkey,
    };
  }

  private logPreflightSummary(proofType: ProofType, finalizedRoot: string, finalizedSlot: number): void {
    this.logger.log(
      [
        'Preflight',
        `  mode: ${proofType}`,
        `  nodeOperatorId: ${this.options.nodeOperatorId}`,
        `  keyIndex: ${this.options.keyIndex}`,
        `  validatorIndex: ${this.options.validatorIndex}`,
        `  clBlock: ${this.options.clBlock ?? 'n/a'}`,
        `  finalizedSlot: ${finalizedSlot}`,
        `  finalizedRoot: ${finalizedRoot}`,
        `  dryRun: ${this.config.get('DRY_RUN')}`,
      ].join('\n'),
    );
  }

  keyInfoFn: KeyInfoFn = (valIndex: number) => {
    if (valIndex === Number(this.options.validatorIndex)) {
      return this.getSelectedKeyInfo();
    }
  };

  fullKeyInfoFn: FullKeyInfoByPubKeyFn = (pubKey: string) => {
    if (pubKey === this.pubkey) {
      return {
        validatorIndex: Number(this.options.validatorIndex),
        ...this.getSelectedKeyInfo(),
      };
    }
  };
}
