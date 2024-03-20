import { Module } from '@nestjs/common';

import { CliService } from './cli.service';
import { ConfigModule } from '../common/config/config.module';
import { LoggerModule } from '../common/logger/logger.module';
import { ProverModule } from '../common/prover/prover.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, ProvidersModule, ProverModule],
  providers: [CliService],
})
export class CliModule {}
