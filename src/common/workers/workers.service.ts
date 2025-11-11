import { Worker, parentPort } from 'node:worker_threads';

import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WorkingMode } from '../config/env.validation';
import { PrometheusService, TrackWorker } from '../prometheus';
import { HistoricalWithdrawalsProofPayload, WithdrawalsProofPayload } from '../prover/types';
import { BuildGeneralWithdrawalProofArgs } from './items/build-general-wd-proof-payloads';
import { BuildHistoricalWithdrawalProofArgs } from './items/build-historical-wd-proof-payloads';
import { GetNewValidatorKeysArgs, GetNewValidatorKeysResult } from './items/get-new-validator-keys';
import { GetValidatorExitEpochsArgs, GetValidatorExitEpochsResult } from './items/get-validator-exit-epochs';

class ParentLoggerMessage {
  __class: string;
  level: string;
  message: string;

  constructor(level: string, message: string) {
    this.__class = ParentLoggerMessage.name;
    this.level = level;
    this.message = message;
  }

  // override `instanceof` behavior to allow simple type checking
  static get [Symbol.hasInstance]() {
    return function (instance: any) {
      return instance.__class === ParentLoggerMessage.name;
    };
  }
}

export class WorkerLogger {
  public static warn(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('warn', message));
  }

  public static log(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('log', message));
  }

  public static error(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('error', message));
  }
}

@Injectable()
export class WorkersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {}

  public async getNewValidatorKeys(args: GetNewValidatorKeysArgs): Promise<GetNewValidatorKeysResult> {
    return await this._run('get-new-validator-keys', args);
  }

  public async getValidatorExitEpochs(args: GetValidatorExitEpochsArgs): Promise<number[]> {
    const result: GetValidatorExitEpochsResult = await this._run('get-validator-exit-epochs', args);
    return result.valExitEpochs;
  }

  public async getGeneralWithdrawalProofPayloads(
    args: BuildGeneralWithdrawalProofArgs,
  ): Promise<WithdrawalsProofPayload[]> {
    return await this._run('build-general-wd-proof-payloads', args);
  }

  public async getHistoricalWithdrawalProofPayloads(
    args: BuildHistoricalWithdrawalProofArgs,
  ): Promise<HistoricalWithdrawalsProofPayload[]> {
    return await this._run('build-historical-wd-proof-payloads', args);
  }

  private async _run<T>(name: string, data: any): Promise<T> {
    if (this.config.get('WORKING_MODE') == WorkingMode.Daemon) {
      return await this._baseRunWithTracker(name, data);
    }
    return await this._baseRun(name, data);
  }

  @TrackWorker()
  private async _baseRunWithTracker<T>(name: string, data: any): Promise<T> {
    return await this._baseRun(name, data);
  }

  private async _baseRun<T>(name: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__dirname + `/items/${name}.js`, {
        workerData: data,
        resourceLimits: {
          maxOldGenerationSizeMb: 8192,
        },
      });
      worker.on('message', (msg) => {
        if (msg instanceof ParentLoggerMessage) {
          switch (msg.level) {
            case 'warn': {
              this.logger.warn(msg.message);
              break;
            }
            case 'log': {
              this.logger.log(msg.message);
              break;
            }
            case 'error': {
              this.logger.error(msg.message);
              break;
            }
          }
          return;
        }
        resolve(msg);
      });
      worker.on('error', (error) => reject(new Error(`Worker error: ${error}`)));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }
}
