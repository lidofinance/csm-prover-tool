import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

import { type AppLogger } from '../common/logger/app-logger.type.js';

@Injectable()
export class CliService implements OnModuleInit {
  constructor(@Inject(WINSTON_MODULE_NEST_PROVIDER) protected readonly logger: AppLogger) {}
  async onModuleInit() {
    this.logger.log('Working mode: CLI');
  }
}
