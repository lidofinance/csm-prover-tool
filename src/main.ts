import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';

import { CliModule } from './cli/cli.module';
import { ConfigService } from './common/config/config.service';
import { WorkingMode } from './common/config/env.validation';
import { DaemonModule } from './daemon/daemon.module';
import { DaemonService } from './daemon/daemon.service';

async function bootstrapCLI() {
  process
    .on('SIGINT', () => process.exit()) // CTRL+C
    .on('SIGQUIT', () => process.exit()) // Keyboard quit
    .on('SIGTERM', () => process.exit()); // `kill` command

  const cliApp = await CommandFactory.createWithoutRunning(CliModule, { logger: false }); // disable initialising logs from NestJS
  await CommandFactory.runApplication(cliApp);
  await cliApp.close();
}

async function bootstrapDaemon() {
  const daemonApp = await NestFactory.create(DaemonModule, { logger: false }); // disable initialising logs from NestJS
  const configService: ConfigService = daemonApp.get(ConfigService);
  await daemonApp.listen(configService.get('HTTP_PORT'), '0.0.0.0');
  daemonApp.get(DaemonService).loop().then();
}

async function bootstrap() {
  switch (process.env.WORKING_MODE) {
    case WorkingMode.CLI:
      await bootstrapCLI();
      break;
    case WorkingMode.Daemon:
      await bootstrapDaemon();
      break;
    default:
      throw new Error('Unknown working mode');
  }
}
bootstrap();
