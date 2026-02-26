import type { LoggerService } from '@nestjs/common';

export type AppLogger = LoggerService & {
  debug(message: unknown, ...optionalParams: unknown[]): void;
};
