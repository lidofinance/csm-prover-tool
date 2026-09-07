import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import streamChain from 'stream-chain';
import { parserStream } from 'stream-json';
import Assembler from 'stream-json/assembler.js';

const { chain } = streamChain;

import type { ELBlockSnapshot, ModuleKeys, ModuleKeysFind, Modules, Status } from './response.interface.js';
import { ConfigService } from '../../config/config.service.js';
import { SECOND_MS } from '../../config/env.validation.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService, TrackKeysAPIRequest } from '../../prometheus/index.js';
import { BaseRestProvider, type RestResponse } from '../base/rest-provider.js';
import { type RequestOptions } from '../base/utils/func.js';

@Injectable()
export class Keysapi extends BaseRestProvider {
  private readonly endpoints = {
    status: 'v1/status',
    modules: 'v1/modules',
    moduleKeys: (module_id: string | number): string => `v1/modules/${module_id}/keys?used=true`,
    findModuleKeys: (module_id: string | number): string => `v1/modules/${module_id}/keys/find?used=true`,
  };

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('KEYSAPI_API_URLS') as Array<string>,
      config.get('KEYSAPI_API_RESPONSE_TIMEOUT_MS'),
      config.get('KEYSAPI_API_MAX_RETRIES'),
      config.get('KEYSAPI_API_RETRY_DELAY_MS'),
      logger,
      prometheus,
    );
  }

  public healthCheck(finalizedTimestamp: number, keysApiMetadata: { elBlockSnapshot: ELBlockSnapshot }): void {
    // Timestamps are Unix seconds, the configured period is milliseconds.
    if (
      (finalizedTimestamp - keysApiMetadata.elBlockSnapshot.timestamp) * SECOND_MS >
      this.config.get('KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD_MS')
    ) {
      throw new Error('KeysApi is outdated');
    }
  }

  public async getStatus(): Promise<Status> {
    return await this.retryRequest(async (baseUrl) => {
      const { body } = await this.baseGet(baseUrl, this.endpoints.status);
      return (await body.json()) as Status;
    });
  }

  public async getModules(): Promise<Modules> {
    return await this.retryRequest(async (baseUrl) => {
      const { body } = await this.baseGet(baseUrl, this.endpoints.modules);
      return (await body.json()) as Modules;
    });
  }

  public async getModuleKeys(module_id: string | number, signal?: AbortSignal): Promise<ModuleKeys> {
    return await this.retryRequest(async (baseUrl) => {
      const { body } = await this.baseGet(baseUrl, this.endpoints.moduleKeys(module_id), { signal });
      // TODO: ignore depositSignature ?
      const pipeline = chain([body, parserStream()]);
      return await new Promise<ModuleKeys>((resolve, reject) => {
        Assembler.connectTo<ModuleKeys>(pipeline, { onDone: (asm) => resolve(asm.current!) });
        pipeline.on('error', reject);
      });
    });
  }

  public async findModuleKeys(
    module_id: string | number,
    keysToFind: string[],
    signal?: AbortSignal,
  ): Promise<ModuleKeysFind> {
    return await this.retryRequest(async (baseUrl) => {
      const { body } = await this.basePost(baseUrl, this.endpoints.findModuleKeys(module_id), {
        pubkeys: keysToFind,
        signal,
      });
      return (await body.json()) as ModuleKeysFind;
    });
  }

  @TrackKeysAPIRequest
  protected baseGet(baseUrl: string, endpoint: string, options?: RequestOptions): Promise<RestResponse> {
    return super.baseGet(baseUrl, endpoint, options);
  }

  @TrackKeysAPIRequest
  protected basePost(
    baseUrl: string,
    endpoint: string,
    requestBody: any,
    options?: RequestOptions,
  ): Promise<RestResponse> {
    return super.basePost(baseUrl, endpoint, requestBody, options);
  }
}
