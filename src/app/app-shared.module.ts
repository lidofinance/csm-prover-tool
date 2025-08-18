import { Module } from '@nestjs/common';

import { ConfigModule } from '@common/config/config.module';
import { ContractsModule } from '@common/contracts';
import { LoggerModule } from '@common/logger/logger.module';
import { ProverModule } from '@common/prover/prover.module';
import { ProvidersModule } from '@common/providers/providers.module';

@Module({
  imports: [ConfigModule, LoggerModule, ContractsModule, ProvidersModule, ProverModule],
  exports: [ConfigModule, LoggerModule, ContractsModule, ProvidersModule, ProverModule],
})
export class AppSharedModule {}
