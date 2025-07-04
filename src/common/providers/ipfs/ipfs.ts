import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import { ConfigService } from '../../config/config.service';
import { MINUTE_MS, SECOND_MS } from '../../config/env.validation';
import { PrometheusService, TrackIPFSRequest } from '../../prometheus';
import { BaseRestProvider } from '../base/rest-provider';
import { RequestOptions } from '../base/utils/func';

@Injectable()
export class Ipfs extends BaseRestProvider {
  private readonly endpoints = {
    ipfs: (cid: string): string => `ipfs/${cid}`,
  };

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
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
  protected baseGet(
    baseUrl: string,
    endpoint: string,
    options?: RequestOptions,
  ): Promise<{ body: BodyReadable; headers: IncomingHttpHeaders }> {
    return super.baseGet(baseUrl, endpoint, options);
  }
}
