import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { type AppLogger } from '../common/logger/app-logger.type.js';

@Injectable()
export class CliService implements OnModuleInit {
  constructor(@Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger) {}
  async onModuleInit() {
    this.logger.log('Working mode: CLI');
  }
}
