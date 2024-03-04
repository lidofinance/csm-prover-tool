import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { connectTo } from 'stream-json/Assembler';

import { ELBlockSnapshot, ModuleKeys, ModuleKeysFind, Modules, Status } from './response.interface';
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

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('KEYSAPI_API_URLS') as Array<string>,
      config.get('KEYSAPI_API_RESPONSE_TIMEOUT_MS'),
      config.get('KEYSAPI_API_MAX_RETRIES'),
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
    return await this.baseJsonGet<Status>(this.mainUrl, this.endpoints.status);
  }

  public async getModules(): Promise<Modules> {
    return await this.baseJsonGet<Modules>(this.mainUrl, this.endpoints.modules);
  }

  public async getModuleKeys(module_id: string | number, signal?: AbortSignal): Promise<ModuleKeys> {
    const resp = await this.baseStreamedGet(this.mainUrl, this.endpoints.moduleKeys(module_id), {
      signal,
    });
    // TODO: ignore depositSignature ?
    const pipeline = chain([resp.body, parser()]);
    return await new Promise((resolve) => {
      connectTo(pipeline).on('done', (asm) => resolve(asm.current));
    });
  }

  public async findModuleKeys(
    module_id: string | number,
    keysToFind: string[],
    signal?: AbortSignal,
  ): Promise<ModuleKeysFind> {
    return await this.baseJsonPost<ModuleKeysFind>(this.mainUrl, this.endpoints.findModuleKeys(module_id), {
      pubkeys: keysToFind,
      signal,
    });
  }
}
