import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { type INestApplicationContext, type LogLevel, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandFactory } from 'nest-commander';

import { CliModule } from './cli/cli.module.js';
import { ConfigService } from './common/config/config.service.js';
import { WorkingMode } from './common/config/env.validation.js';
import { DaemonModule } from './daemon/daemon.module.js';
import { DaemonService } from './daemon/daemon.service.js';

const BOOTSTRAP_LOGGER_OPTIONS = {
  bufferLogs: true,
  autoFlushLogs: false,
  logger: ['error'] as LogLevel[],
};

// CLI mode keeps simple `process.exit()` handlers. Daemon mode does NOT — it
// relies on `app.enableShutdownHooks()` so Nest can call our
// `OnApplicationShutdown` hook and let the loop exit cooperatively.
function attachCliExitHandlers(): void {
  process
    .on('SIGINT', () => process.exit()) // CTRL+C
    .on('SIGQUIT', () => process.exit()) // Keyboard quit
    .on('SIGTERM', () => process.exit()); // `kill` command
}

async function bootstrap() {
  switch (process.env.WORKING_MODE) {
    case WorkingMode.CLI:
      attachCliExitHandlers();
      await bootstrapCLI();
      break;
    case WorkingMode.Daemon:
      await bootstrapDaemon();
      break;
    default:
      throw new Error('Unknown working mode');
  }
}

async function bootstrapCLI() {
  await bootstrapApp(
    'CLI application',
    () => CommandFactory.createWithoutRunning(CliModule, BOOTSTRAP_LOGGER_OPTIONS),
    async (app) => {
      try {
        await CommandFactory.runApplication(app);
      } finally {
        await app.close();
      }
    },
  );
}

async function bootstrapDaemon() {
  await bootstrapApp(
    'daemon application',
    () => NestFactory.create(DaemonModule, BOOTSTRAP_LOGGER_OPTIONS),
    async (app) => {
      const configService: ConfigService = app.get(ConfigService);
      app.enableShutdownHooks();
      await app.listen(configService.get('HTTP_PORT'), '0.0.0.0');
      app.get(DaemonService).loop().then();
    },
  );
}

async function bootstrapApp<TApp extends INestApplicationContext>(
  appName: string,
  create: () => Promise<TApp>,
  run: (app: TApp) => Promise<void>,
): Promise<void> {
  let app: TApp | undefined;
  try {
    app = await create();
    configureAppLogger(app);
    await run(app);
  } catch (error) {
    await failBootstrap(appName, error, app);
  }
}

function configureAppLogger(app: INestApplicationContext): void {
  app.useLogger(app.get(LOGGER_PROVIDER));
  Logger.detachBuffer();
}

async function failBootstrap(appName: string, error: unknown, app?: INestApplicationContext): Promise<never> {
  const logger = app?.get(LOGGER_PROVIDER);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  logger ? logger.error(`Failed to initialize ${appName}: ${message}`) : console.error(message);
  if (stack) {
    logger ? logger.error(stack) : console.error(stack);
  }
  Logger.flush();

  if (app) {
    await app.close();
  }

  process.exit(1);
}

bootstrap();
