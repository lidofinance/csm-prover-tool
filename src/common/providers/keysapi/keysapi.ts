import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import streamChain from 'stream-chain';
import streamJson from 'stream-json';
import Assembler from 'stream-json/Assembler.js';

const { chain } = streamChain;
const { parser } = streamJson;

import type { ELBlockSnapshot, ModuleKeys, ModuleKeysFind, Modules, Status } from './response.interface.js';
import { ConfigService } from '../../config/config.service.js';
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
    if (
      finalizedTimestamp - keysApiMetadata.elBlockSnapshot.timestamp >
      this.config.get('KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD_MS')
    ) {
      throw new Error('KeysApi is outdated');
    }
  }

  public async getStatus(): Promise<Status> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.status));
    return (await body.json()) as Status;
  }

  public async getModules(): Promise<Modules> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.modules));
    return (await body.json()) as Modules;
  }

  public async getModuleKeys(module_id: string | number, signal?: AbortSignal): Promise<ModuleKeys> {
    const resp = await this.retryRequest((baseUrl) =>
      this.baseGet(baseUrl, this.endpoints.moduleKeys(module_id), { signal }),
    );
    // TODO: ignore depositSignature ?
    const pipeline = chain([resp.body, parser()]);
    return await new Promise((resolve) => {
      Assembler.connectTo(pipeline).on('done', (asm) => resolve(asm.current));
    });
  }

  public async findModuleKeys(
    module_id: string | number,
    keysToFind: string[],
    signal?: AbortSignal,
  ): Promise<ModuleKeysFind> {
    const { body } = await this.retryRequest((baseUrl) =>
      this.basePost(baseUrl, this.endpoints.findModuleKeys(module_id), { pubkeys: keysToFind, signal }),
    );
    return (await body.json()) as ModuleKeysFind;
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
