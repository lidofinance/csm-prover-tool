import { Module } from '@nestjs/common';

import { CliService } from './cli.service.js';
import { ProveCommand } from './commands/prove.command.js';
import { ProofInputQuestion } from './questions/proof-input.question.js';
import { TxExecutionQuestion } from './questions/tx-execution.question.js';
import { ConfigModule } from '../common/config/config.module.js';
import { ContractsModule } from '../common/contracts/contracts.module.js';
import { LoggerModule } from '../common/logger/logger.module.js';
import { ProverModule } from '../common/prover/prover.module.js';
import { ProvidersModule } from '../common/providers/providers.module.js';

@Module({
  imports: [LoggerModule, ConfigModule, ContractsModule, ProvidersModule, ProverModule],
  providers: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
  exports: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
})
export class CliModule {}
