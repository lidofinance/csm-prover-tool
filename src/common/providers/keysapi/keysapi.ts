import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { connectTo } from 'stream-json/Assembler';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import { ConfigService } from '../../config/config.service';
import { PrometheusService } from '../../prometheus/prometheus.service';
import { BaseRestProvider } from '../base/rest-provider';

@Injectable()
export class Keysapi extends BaseRestProvider {
  private readonly endpoints = {
    status: 'v1/status',
    modules: 'v1/modules',
    moduleKeys: (module_id: string | number): string => `v1/modules/${module_id}/keys`,
    findModuleKeys: (module_id: string | number): string => `v1/modules/${module_id}/keys/find`,
  };

  // TODO: types

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('KEYSAPI_API_URLS') as Array<string>,
      config.get('KEYSAPI_API_RESPONSE_TIMEOUT'),
      config.get('KEYSAPI_API_MAX_RETRIES'),
      logger,
      prometheus,
    );
  }

  public healthCheck(finalizedTimestamp: number, keysApiMetadata: any): void {
    if (
      finalizedTimestamp - keysApiMetadata.elBlockSnapshot.timestamp >
      this.config.get('KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD')
    ) {
      throw new Error('KeysApi is outdated');
    }
  }

  public async getStatus(): Promise<any> {
    return await this.baseGet(this.mainUrl, this.endpoints.status);
  }

  public async getModules(): Promise<any> {
    return await this.baseGet(this.mainUrl, this.endpoints.modules);
  }

  public async getModuleKeys(module_id: string | number, signal?: AbortSignal): Promise<any> {
    const resp: { body: BodyReadable; headers: IncomingHttpHeaders } = await this.baseGet(
      this.mainUrl,
      this.endpoints.moduleKeys(module_id),
      {
        streamed: true,
        signal,
      },
    );
    // TODO: ignore depositSignature ?
    const pipeline = chain([resp.body, parser()]);
    return await new Promise((resolve) => {
      connectTo(pipeline).on('done', (asm) => resolve(asm.current));
    });
  }

  public async findModuleKeys(module_id: string | number, keysToFind: string[], signal?: AbortSignal): Promise<any> {
    return await this.basePost(this.mainUrl, this.endpoints.findModuleKeys(module_id), { pubkeys: keysToFind, signal });
  }
}
