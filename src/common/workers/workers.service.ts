import { Worker } from 'node:worker_threads';

import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../config/config.service.js';
import { WorkingMode } from '../config/env.validation.js';
import { type AppLogger } from '../logger/app-logger.type.js';
import { PrometheusService, TrackWorker } from '../prometheus/index.js';
import type { BuildBalanceProofArgs } from './items/build-balance-proof-payloads.js';
import type { BuildGeneralWithdrawalProofArgs } from './items/build-general-wd-proof-payloads.js';
import type { BuildHistoricalBalanceProofArgs } from './items/build-historical-balance-proof-payloads.js';
import type { BuildHistoricalWithdrawalProofArgs } from './items/build-historical-wd-proof-payloads.js';
import type { BuildSlashingProofArgs } from './items/build-slashing-proof-payloads.js';
import type { GetNewValidatorKeysArgs, GetNewValidatorKeysResult } from './items/get-new-validator-keys.js';
import type { GetValidatorBalancesArgs, GetValidatorBalancesResult } from './items/get-validator-balances.js';
import type { GetValidatorExitEpochsArgs, GetValidatorExitEpochsResult } from './items/get-validator-exit-epochs.js';
import { ParentLoggerMessage } from './worker-logger.js';
import type { IVerifier } from '../contracts/types/Verifier.js';

const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class WorkersService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {}

  public async getNewValidatorKeys(args: GetNewValidatorKeysArgs): Promise<GetNewValidatorKeysResult> {
    return await this._run('get-new-validator-keys', args);
  }

  public async getValidatorBalances(args: GetValidatorBalancesArgs): Promise<bigint[]> {
    const result: GetValidatorBalancesResult = await this._run('get-validator-balances', args);
    return result.valBalances;
  }

  public async getValidatorExitEpochs(args: GetValidatorExitEpochsArgs): Promise<bigint[]> {
    const result: GetValidatorExitEpochsResult = await this._run('get-validator-exit-epochs', args);
    return result.valExitEpochs;
  }

  public async getSlashedProofPayloads(args: BuildSlashingProofArgs): Promise<IVerifier.ProcessSlashedInputStruct[]> {
    return await this._run('build-slashing-proof-payloads', args);
  }

  public async getGeneralWithdrawalProofPayloads(
    args: BuildGeneralWithdrawalProofArgs,
  ): Promise<IVerifier.ProcessWithdrawalInputStruct[]> {
    return await this._run('build-general-wd-proof-payloads', args);
  }

  public async getHistoricalWithdrawalProofPayloads(
    args: BuildHistoricalWithdrawalProofArgs,
  ): Promise<IVerifier.ProcessHistoricalWithdrawalInputStruct[]> {
    return await this._run('build-historical-wd-proof-payloads', args);
  }

  public async getBalanceProofPayloads(
    args: BuildBalanceProofArgs,
  ): Promise<IVerifier.ProcessBalanceProofInputStruct[]> {
    return await this._run('build-balance-proof-payloads', args);
  }

  public async getHistoricalBalanceProofPayloads(
    args: BuildHistoricalBalanceProofArgs,
  ): Promise<IVerifier.ProcessHistoricalBalanceProofInputStruct[]> {
    return await this._run('build-historical-balance-proof-payloads', args);
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
      const worker = new Worker(new URL(`./items/${name}.js`, import.meta.url), {
        workerData: data,
        resourceLimits: {
          maxOldGenerationSizeMb: 8192,
        },
      });
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          this.logger.warn(`Worker ${name} timed out after ${WORKER_TIMEOUT_MS}ms; terminating`);
          worker.terminate().catch(() => {
            /* terminate is best-effort */
          });
          reject(new Error(`Worker ${name} timed out after ${WORKER_TIMEOUT_MS}ms`));
        });
      }, WORKER_TIMEOUT_MS);
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
        settle(() => resolve(msg));
      });
      worker.on('error', (error) => settle(() => reject(new Error('Worker error', { cause: error }))));
      worker.on('exit', (code) => {
        if (code !== 0) settle(() => reject(new Error(`Worker stopped with exit code ${code}`)));
      });
    });
  }
}
