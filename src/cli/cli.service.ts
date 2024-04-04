import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

@Injectable()
export class CliService implements OnModuleInit {
  constructor(@Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService) {}
  async onModuleInit() {
    this.logger.log('Working mode: CLI');
  }
}
