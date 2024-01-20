import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import {
  Inject,
  Injectable,
  LoggerService,
  OnApplicationBootstrap,
} from '@nestjs/common';

@Injectable()
export class CliService implements OnApplicationBootstrap {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
  ) {}
  async onApplicationBootstrap() {
    this.logger.log('Working mode: CLI');
  }
}
