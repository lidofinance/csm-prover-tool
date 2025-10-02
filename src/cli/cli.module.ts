import { Module } from '@nestjs/common';

import { AppSharedModule } from '@app/app-shared.module';

import { CliService } from './cli.service';
import { ProveCommand } from './commands/prove.command';
import { ProofInputQuestion } from './questions/proof-input.question';
import { TxExecutionQuestion } from './questions/tx-execution.question';

@Module({
  imports: [AppSharedModule],
  providers: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
  exports: [CliService, ProveCommand, ProofInputQuestion, TxExecutionQuestion],
})
export class CliModule {}
