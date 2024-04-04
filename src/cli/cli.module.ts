import { Module } from '@nestjs/common';

import { CliService } from './cli.service';
import { ProveCommand } from './commands/prove.command';
import { ProofInputQuestion } from './questions/proof-input.question';
import { TxExecutionQuestion } from './questions/tx-execution.question';
import { ConfigModule } from '../common/config/config.module';
import { ContractsModule } from '../common/contracts/contracts.module';
import { LoggerModule } from '../common/logger/logger.module';
import { ProverModule } from '../common/prover/prover.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, ContractsModule, ProvidersModule, ProverModule],
  providers: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
  exports: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
})
export class CliModule {}
