import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { ConfigService } from '../../config/config.service.js';
import { MINUTE_MS, SECOND_MS } from '../../config/env.validation.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService, TrackIPFSRequest } from '../../prometheus/index.js';
import { BaseRestProvider, type RestResponse } from '../base/rest-provider.js';
import { type RequestOptions } from '../base/utils/func.js';

const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

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

  // `parse` runs inside the retry boundary, so a malformed or unauthenticated artifact rotates gateways.
  public async get<T>(cid: string, parse: (data: any) => T): Promise<T> {
    return await this.retryRequest(async (baseUrl) => {
      const { body, headers } = await this.baseGet(baseUrl, this.endpoints.ipfs(cid));
      const oversized = new Error(`IPFS response for [${cid}] exceeds ${MAX_RESPONSE_BYTES} bytes`);
      if (Number(headers['content-length']) > MAX_RESPONSE_BYTES) {
        await body.dump().catch(() => {});
        throw oversized;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw oversized;
        chunks.push(chunk);
      }
      return parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    });
  }

  @TrackIPFSRequest
  protected baseGet(baseUrl: string, endpoint: string, options?: RequestOptions): Promise<RestResponse> {
    return super.baseGet(baseUrl, endpoint, options);
  }
}
