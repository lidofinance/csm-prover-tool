import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import traverse from 'traverse';
import { BaseError } from 'viem';
import { format, transports as winstonTransports } from 'winston';

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

const SECRET_REPLACER = '<removed>';

const cleanSecrets = format((info, { secrets }: { secrets: string[] }) =>
  traverse(info).map(function (node) {
    if (this.level >= 10) {
      this.update('Maximum secret sanitizing depth reached.');
      this.stop();
      return;
    }
    if (typeof node === 'string') {
      this.update(secrets.reduce((text, secret) => (secret ? text.replaceAll(secret, SECRET_REPLACER) : text), node));
    }
  }),
);

const jsonTransport = ({ secrets }: { secrets: string[] }) =>
  new winstonTransports.Console({ format: format.combine(cleanSecrets({ secrets }), format.json()) });

const simpleTransport = ({ secrets }: { secrets: string[] }) =>
  new winstonTransports.Console({
    format: format.combine(
      format.colorize({ all: true }),
      cleanSecrets({ secrets }),
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.printf((log) => {
        const { timestamp, level, message, context, stack, ...rest } = log;
        const extra = context ? JSON.stringify(context) : '';
        // If there are extra keys, then an array or an object was logged
        const text = !Object.keys(rest).length ? message : JSON.stringify(rest);
        return [timestamp, `${level}:`, text, stack, extra].filter((v) => v != null && String(v) !== '').join(' ');
      }),
    ),
  });

@Module({
  imports: [
    WinstonModule.forRootAsync({
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
