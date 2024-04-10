import { LoggerService } from '@nestjs/common';

export interface RequestPolicy {
  timeout: number;
  maxRetries: number;
  retryDelay: number;
}

export interface RequestOptions {
  requestPolicy?: RequestPolicy;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export const rejectDelay = (delayMs: number) => (err: any) => {
  return new Promise<never>(function (resolve, reject) {
    setTimeout(() => reject(err), delayMs);
  });
};

export const sleep = (delayMs: number) => {
  return new Promise<void>(function (resolve) {
    setTimeout(() => resolve(), delayMs);
  });
};

export const retrier = (
  logger: LoggerService,
  defaultMaxRetryCount = 3,
  defaultMinBackoffMs = 1000,
  defaultMaxBackoffMs = 60000,
  defaultLogWarning = false,
) => {
  return async <T>(
    callback: () => Promise<T>,
    maxRetryCount?: number,
    minBackoffMs?: number,
    maxBackoffMs?: number,
    logWarning?: boolean,
  ): Promise<T> => {
    maxRetryCount = maxRetryCount ?? defaultMaxRetryCount;
    minBackoffMs = minBackoffMs ?? defaultMinBackoffMs;
    maxBackoffMs = maxBackoffMs ?? defaultMaxBackoffMs;
    logWarning = logWarning ?? defaultLogWarning;
    try {
      return await callback();
    } catch (err: any) {
      if (maxRetryCount <= 1 || minBackoffMs >= maxBackoffMs) {
        throw err;
      }
      if (logWarning) {
        logger.warn(err.message, `Retrying after (${minBackoffMs}ms). Remaining retries [${maxRetryCount}]`);
      }
      await sleep(minBackoffMs);
      return await retrier(logger)(callback, maxRetryCount - 1, minBackoffMs * 2, maxBackoffMs, logWarning);
    }
  };
};
