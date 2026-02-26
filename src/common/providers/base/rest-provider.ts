import { type Dispatcher, request } from 'undici';

import { type RequestOptions, type RequestPolicy, rejectDelay, retrier, urljoin } from './utils/func.js';
import type { AppLogger } from '../../logger/app-logger.type.js';
import { type PrometheusService } from '../../prometheus/index.js';

export type RestResponse = {
  body: Dispatcher.ResponseData['body'];
  headers: Dispatcher.ResponseData['headers'];
};

export type RetryOptions = RequestOptions &
  RequestPolicy & {
    useFallbackOnRejected?: (err: Error, current_error: Error) => boolean;
    useFallbackOnResolved?: (data: any) => boolean;
  };

class RequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
  }
}

export abstract class BaseRestProvider {
  protected readonly baseUrls: string[];
  protected readonly requestPolicy: RequestPolicy;

  protected constructor(
    urls: Array<string>,
    responseTimeout: number,
    maxRetries: number,
    retryDelay: number,
    protected readonly logger: AppLogger,
    protected readonly prometheus?: PrometheusService,
  ) {
    this.baseUrls = urls;
    this.requestPolicy = {
      timeout: responseTimeout,
      maxRetries,
      retryDelay,
    };
  }

  protected async retryRequest(
    callback: (apiURL: string, options?: RequestOptions) => Promise<RestResponse>,
    options?: RetryOptions,
  ): Promise<RestResponse> {
    options = {
      ...this.requestPolicy,
      useFallbackOnRejected: () => true, //  use fallback on error as default
      useFallbackOnResolved: () => false, // do NOT use fallback on success as default
      ...options,
    };
    const retry = retrier(this.logger, options.maxRetries, this.requestPolicy.retryDelay, 10000, true);
    let res;
    let err = Error('');
    for (let i = 0; i < this.baseUrls.length; i++) {
      if (res) break;
      res = await callback(this.baseUrls[i], options)
        .catch(rejectDelay(this.requestPolicy.retryDelay))
        .catch(() => retry(() => callback(this.baseUrls[i], options)))
        .then((r: any) => {
          if (options?.useFallbackOnResolved && options.useFallbackOnResolved(r)) {
            err = Error('Unresolved data on a successful CL API response');
            return undefined;
          }
          return r;
        })
        .catch((current_error: any) => {
          if (options?.useFallbackOnRejected && options.useFallbackOnRejected(err, current_error)) {
            err = current_error;
            return undefined;
          }
          throw current_error;
        });
      if (i == this.baseUrls.length - 1 && !res) {
        err.message = `Error while doing CL API request on all passed URLs. ${err.message}`;
        throw err;
      }
      if (!res) {
        this.logger.warn(`${err.message}. Error while doing CL API request. Will try to switch to another API URL`);
      }
    }

    return res;
  }

  protected async baseGet(base: string, endpoint: string, options?: RequestOptions): Promise<RestResponse> {
    options = {
      requestPolicy: this.requestPolicy,
      ...options,
    } as RequestOptions;
    const { body, headers, statusCode } = await request(urljoin(base, endpoint), {
      method: 'GET',
      headersTimeout: (options.requestPolicy as RequestPolicy).timeout,
      signal: options.signal,
      headers: options.headers,
    });
    if (statusCode !== 200) {
      const hostname = new URL(base).hostname;
      throw new RequestError(
        `Request failed with status code [${statusCode}] on host [${hostname}]: ${endpoint}`,
        statusCode,
      );
    }
    return { body: body, headers: headers };
  }

  protected async basePost(
    base: string,
    endpoint: string,
    requestBody: any,
    options?: RequestOptions,
  ): Promise<RestResponse> {
    options = {
      requestPolicy: this.requestPolicy,
      ...options,
    } as RequestOptions;
    const { body, headers, statusCode } = await request(urljoin(base, endpoint), {
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
      throw new RequestError(
        `Request failed with status code [${statusCode}] on host [${hostname}]: ${endpoint}`,
        statusCode,
      );
    }
    return { body: body, headers: headers };
  }
}
