import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../../config/config.service.js';
import { MINUTE_MS, SECOND_MS } from '../../config/env.validation.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService, TrackIPFSRequest } from '../../prometheus/index.js';
import { BaseRestProvider, type RestResponse } from '../base/rest-provider.js';
import { type RequestOptions } from '../base/utils/func.js';

@Injectable()
export class Ipfs extends BaseRestProvider {
  private readonly endpoints = {
    ipfs: (cid: string): string => `ipfs/${cid}`,
  };

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
  ) {
    const responseTimeout = MINUTE_MS;
    const maxRetries = 3;
    const retryDelay = SECOND_MS / 2;
    super(
      ['https://ipfs.io', 'https://gateway.pinata.cloud'],
      responseTimeout,
      maxRetries,
      retryDelay,
      logger,
      prometheus,
    );
  }

  public async get(cid: string): Promise<any> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.ipfs(cid)));
    return await body.json();
  }

  @TrackIPFSRequest
  protected baseGet(baseUrl: string, endpoint: string, options?: RequestOptions): Promise<RestResponse> {
    return super.baseGet(baseUrl, endpoint, options);
  }
}
