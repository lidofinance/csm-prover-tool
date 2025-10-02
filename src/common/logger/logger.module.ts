import { LoggerModule as Logger, jsonTransport, simpleTransport } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';

import { ConfigService } from '../config/config.service';
import { LogFormat } from '../config/interfaces';

@Module({
  imports: [
    Logger.forRootAsync({
      // ConfigModule is global, no need to import explicitly
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const { secrets } = configService;
        const level = configService.get('LOG_LEVEL');
        const format = configService.get('LOG_FORMAT');
        const isJSON = format === LogFormat.JSON;

        const transports = isJSON ? jsonTransport({ secrets }) : simpleTransport({ secrets });

        return { level, transports };
      },
    }),
  ],
})
export class LoggerModule {}
