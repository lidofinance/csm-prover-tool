import { LoggerModule as Logger, jsonTransport, simpleTransport } from '@lido-nestjs/logger';
import { Module } from '@nestjs/common';
import { BaseError } from 'viem';
import { format } from 'winston';

import { ConfigModule } from '../config/config.module.js';
import { ConfigService } from '../config/config.service.js';
import { LogFormat } from '../config/interfaces/environment.interface.js';

// logger.error(e) spreads an Error's own properties into the log record, and a viem error carries the whole ABI
const boundViemError = format((info) => {
  if (info.error instanceof BaseError) {
    for (const key of Object.keys(info.error)) delete info[key];
    delete info.error;
  }
  return info;
});

@Module({
  imports: [
    Logger.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const { secrets } = configService;
        const level = configService.get('LOG_LEVEL');
        const format = configService.get('LOG_FORMAT');
        const isJSON = format === LogFormat.JSON;

        const transports = isJSON ? jsonTransport({ secrets }) : simpleTransport({ secrets });

        return { level, transports, format: boundViemError() };
      },
    }),
  ],
})
export class LoggerModule {}
