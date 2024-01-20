import { Module } from '@nestjs/common';

import { CliService } from './cli.service';
import { ConfigModule } from '../common/config/config.module';
import { HandlersModule } from '../common/handlers/handlers.module';
import { LoggerModule } from '../common/logger/logger.module';
import { ProvidersModule } from '../common/providers/providers.module';

@Module({
  imports: [LoggerModule, ConfigModule, ProvidersModule, HandlersModule],
  providers: [CliService],
})
export class CliModule {}
