import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';

import { ConfigService } from '@common/config/config.service';
import { WorkingMode } from '@common/config/env.validation';

import { CliModule } from '@cli/cli.module';

import { DaemonModule } from '@daemon/daemon.module';
import { DaemonService } from '@daemon/daemon.service';

function registerProcessHandlers() {
  process
    .on('SIGINT', () => process.exit())
    .on('SIGQUIT', () => process.exit())
    .on('SIGTERM', () => process.exit())
    .on('unhandledRejection', (reason) => {
      // eslint-disable-next-line no-console
      console.error('Unhandled Rejection:', reason);
    })
    .on('uncaughtException', (err) => {
      // eslint-disable-next-line no-console
      console.error('Uncaught Exception:', err);
      process.exit(1);
    });
}

async function runCli(): Promise<void> {
  registerProcessHandlers();
  const cliApp = await CommandFactory.createWithoutRunning(CliModule, { bufferLogs: true });
  cliApp.useLogger(cliApp.get(LOGGER_PROVIDER));
  await CommandFactory.runApplication(cliApp);
  await cliApp.close();
}

async function runDaemon(): Promise<void> {
  registerProcessHandlers();
  let daemonApp;
  try {
    daemonApp = await NestFactory.create(DaemonModule, { bufferLogs: true });
    daemonApp.useLogger(daemonApp.get(LOGGER_PROVIDER));
    const configService: ConfigService = daemonApp.get(ConfigService);
    await daemonApp.listen(configService.get('HTTP_PORT'), '0.0.0.0');
  } catch (error: any) {
    const logger = daemonApp?.get(LOGGER_PROVIDER);
    const errorMsg = `Failed to initialize daemon application: ${error.message}`;
    logger ? logger.error(errorMsg) : console.error(errorMsg); // eslint-disable-line no-console
    if (daemonApp) await daemonApp.close();
    process.exit(1);
  }
  daemonApp.get(DaemonService).loop().then();
}

export async function run(): Promise<void> {
  switch (process.env.WORKING_MODE) {
    case WorkingMode.CLI:
      await runCli();
      return;
    case WorkingMode.Daemon:
      await runDaemon();
      return;
    default:
      throw new Error('Unknown working mode');
  }
}
