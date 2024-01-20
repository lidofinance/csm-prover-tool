import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';

import { CliModule } from './cli/cli.module';
import { ConfigService } from './common/config/config.service';
import { WorkingMode } from './common/config/env.validation';
import { DaemonModule } from './daemon/daemon.module';

async function bootstrapCli() {
  const cliApp = await CommandFactory.createWithoutRunning(CliModule, {
    bufferLogs: true,
  });
  cliApp.useLogger(cliApp.get(LOGGER_PROVIDER));
  await CommandFactory.runApplication(cliApp);
  await cliApp.close();
}

async function bootstrapDaemon() {
  const daemonApp = await NestFactory.create(DaemonModule, {
    bufferLogs: true,
  });
  daemonApp.useLogger(daemonApp.get(LOGGER_PROVIDER));
  const configService: ConfigService = daemonApp.get(ConfigService);
  await daemonApp.listen(configService.get('HTTP_PORT'), '0.0.0.0');
}

async function bootstrap() {
  switch (process.env.WORKING_MODE) {
    case WorkingMode.CLI:
      await bootstrapCli();
      break;
    case WorkingMode.Daemon:
      await bootstrapDaemon();
      break;
    default:
      throw new Error('Unknown working mode');
  }
}
bootstrap();
