import { Worker, parentPort } from 'node:worker_threads';

import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WorkingMode } from '../config/env.validation';
import { PrometheusService, TrackTask } from '../prometheus';

export function parentWarn(message: string): void {
  parentPort?.postMessage(new ParentLoggerMessage('warn', message));
}

export function parentLog(message: string): void {
  parentPort?.postMessage(new ParentLoggerMessage('log', message));
}

class ParentLoggerMessage {
  level: string;
  message: string;
  logger?: LoggerService;

  constructor(level: string, message: string) {
    this.level = level;
    this.message = message;
  }
}

@Injectable()
export class WorkersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {}

  public async run<T>(name: string, data: any): Promise<T> {
    if (this.config.get('WORKING_MODE') == WorkingMode.CLI) {
      return await this._run(name, data);
    } else {
      return await this._withWithTracker(name, data);
    }
  }

  @TrackTask('run-worker')
  private async _withWithTracker<T>(name: string, data: any): Promise<T> {
    return await this._run(name, data);
  }

  private async _run<T>(name: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__dirname + `/items/${name}.js`, {
        workerData: data,
        resourceLimits: {
          maxOldGenerationSizeMb: 8192,
        },
      });
      worker.on('message', (msg) => {
        if (msg.level !== undefined && msg.message !== undefined) {
          switch (msg.level) {
            case 'warn': {
              this.logger.warn(msg.message);
              break;
            }
            case 'log': {
              this.logger.log(msg.message);
              break;
            }
          }
        } else resolve(msg);
      });
      worker.on('error', (error) => reject(new Error(`Worker error: ${error}`)));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }
}
