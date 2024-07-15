import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, LoggerService } from '@nestjs/common';
import { Command as Commander } from 'commander';
import { Command, CommandRunner, InjectCommander, InquirerService, Option } from 'nest-commander';

import { CsmContract } from '../../common/contracts/csm-contract.service';
import { ProverService } from '../../common/prover/prover.service';
import { KeyInfoFn } from '../../common/prover/types';
import { Consensus } from '../../common/providers/consensus/consensus';

type ProofOptions = {
  nodeOperatorId: string;
  keyIndex: string;
  validatorIndex: string;
  block: string;
};

@Command({
  name: 'prove',
  description: 'Prove a withdrawal or slashing',
  arguments: '<withdrawal|slashing>',
  argsDescription: {
    withdrawal: 'Prove a withdrawal',
    slashing: 'Prove a slashing',
  },
})
export class ProveCommand extends CommandRunner {
  private options: ProofOptions;
  private pubkey: string;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @InjectCommander() private readonly commander: Commander,
    protected readonly inquirerService: InquirerService,
    protected readonly csm: CsmContract,
    protected readonly consensus: Consensus,
    protected readonly prover: ProverService,
  ) {
    super();
  }

  async run(inputs: string[], options?: ProofOptions) {
    try {
      this.options = await this.inquirerService.ask('proof-input', options);
      this.logger.debug!(this.options);
      this.pubkey = await this.csm.getNodeOperatorKey(this.options.nodeOperatorId, this.options.keyIndex);
      this.logger.debug!(`Validator public key: ${this.pubkey}`);
      const header = await this.consensus.getBeaconHeader('finalized');
      this.logger.debug!(`Finalized slot [${header.header.message.slot}]. Root [${header.root}]`);
      const { root: blockRootToProcess } = await this.consensus.getBeaconHeader(this.options.block);
      const blockInfoToProcess = await this.consensus.getBlockInfo(this.options.block);
      this.logger.debug!(`Block to process [${this.options.block}]`);

      switch (inputs[0]) {
        case 'withdrawal':
          await this.prover.handleWithdrawalsInBlock(blockRootToProcess, blockInfoToProcess, header, this.keyInfoFn);
          break;
        case 'slashing':
          await this.prover.handleSlashingsInBlock(blockInfoToProcess, header, this.keyInfoFn);
          break;
      }
    } catch (e) {
      this.commander.error(e);
    }
  }

  @Option({
    flags: '--node-operator-id <nodeOperatorId>',
    description: 'Node Operator ID from the CSM',
  })
  parseNodeOperatorId(val: string) {
    return val;
  }

  @Option({
    flags: '--key-index <keyIndex>',
    description: 'Key Index from the CSM',
  })
  parseKeyIndex(val: string) {
    return val;
  }

  @Option({
    flags: '--validator-index <validatorIndex>',
    description: 'Validator Index from the Consensus Layer',
  })
  parseValidatorIndex(val: string) {
    return val;
  }

  @Option({
    flags: '--block <block>',
    description: 'Block from the Consensus Layer with validator withdrawal. Might be a block root or a slot number',
  })
  parseBlock(val: string) {
    return val;
  }

  keyInfoFn: KeyInfoFn = (valIndex: number) => {
    if (valIndex === Number(this.options.validatorIndex)) {
      return {
        operatorId: Number(this.options.nodeOperatorId),
        keyIndex: Number(this.options.keyIndex),
        pubKey: this.pubkey,
      };
    }
  };
}
