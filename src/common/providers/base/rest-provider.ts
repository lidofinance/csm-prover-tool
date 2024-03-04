import { LoggerService } from '@nestjs/common';
import { request } from 'undici';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import { PrometheusService } from '../../prometheus/prometheus.service';

export interface RequestPolicy {
  timeout: number;
  maxRetries: number;
  fallbacks: Array<string>;
}

export interface RequestOptions {
  streamed?: boolean;
  requestPolicy?: RequestPolicy;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export abstract class BaseRestProvider {
  protected readonly mainUrl: string;
  protected readonly requestPolicy: RequestPolicy;

  protected constructor(
    urls: Array<string>,
    responseTimeout: number,
    maxRetries: number,
    protected readonly logger: LoggerService,
    protected readonly prometheus?: PrometheusService,
  ) {
    this.mainUrl = urls[0];
    this.requestPolicy = {
      timeout: responseTimeout,
      maxRetries: maxRetries,
      fallbacks: urls.slice(1),
    };
  }

  // TODO: Request should have:
  //  1. metrics (if it is daemon mode)
  //  2. retries
  //  3. fallbacks

  protected async baseJsonGet<T>(base: string, endpoint: string, options?: RequestOptions): Promise<T> {
    return (await this.baseGet<T>(base, endpoint, { ...options, streamed: false })) as T;
  }

  protected async baseStreamedGet(
    base: string,
    endpoint: string,
    options?: RequestOptions,
  ): Promise<{ body: BodyReadable; headers: IncomingHttpHeaders }> {
    return (await this.baseGet(base, endpoint, { ...options, streamed: true })) as {
      body: BodyReadable;
      headers: IncomingHttpHeaders;
    };
  }

  protected async baseJsonPost<T>(
    base: string,
    endpoint: string,
    requestBody: any,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.basePost<T>(base, endpoint, requestBody, { ...options, streamed: false })) as T;
  }

  protected async baseStreamedPost(
    base: string,
    endpoint: string,
    requestBody: any,
    options?: RequestOptions,
  ): Promise<{ body: BodyReadable; headers: IncomingHttpHeaders }> {
    return (await this.basePost(base, endpoint, requestBody, { ...options, streamed: true })) as {
      body: BodyReadable;
      headers: IncomingHttpHeaders;
    };
  }

  private async baseGet<T>(
    base: string,
    endpoint: string,
    options?: RequestOptions,
  ): Promise<T | { body: BodyReadable; headers: IncomingHttpHeaders }> {
    options = {
      streamed: false,
      requestPolicy: this.requestPolicy,
      ...options,
    } as RequestOptions;
    const { body, headers, statusCode } = await request(new URL(endpoint, base), {
      method: 'GET',
      headersTimeout: (options.requestPolicy as RequestPolicy).timeout,
      signal: options.signal,
      headers: options.headers,
    });
    if (statusCode !== 200) {
      const hostname = new URL(base).hostname;
      throw new Error(`Request failed with status code [${statusCode}] on host [${hostname}]: ${endpoint}`);
    }
    return options.streamed ? { body: body, headers: headers } : ((await body.json()) as T);
  }

  private async basePost<T>(
    base: string,
    endpoint: string,
    requestBody: any,
    options?: RequestOptions,
  ): Promise<T | { body: BodyReadable; headers: IncomingHttpHeaders }> {
    options = {
      streamed: false,
      requestPolicy: this.requestPolicy,
      ...options,
    } as RequestOptions;
    const { body, headers, statusCode } = await request(new URL(endpoint, base), {
      method: 'POST',
      headersTimeout: (options.requestPolicy as RequestPolicy).timeout,
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    if (statusCode !== 200) {
      const hostname = new URL(base).hostname;
      throw new Error(`Request failed with status code [${statusCode}] on host [${hostname}]: ${endpoint}`);
    }
    return options.streamed ? { body: body, headers: headers } : ((await body.json()) as T);
  }
}
