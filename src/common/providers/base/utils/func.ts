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

function normalize(strArray: string[]) {
  const resultArray = [];
  if (strArray.length === 0) {
    return '';
  }

  if (typeof strArray[0] !== 'string') {
    throw new TypeError('Url must be a string. Received ' + strArray[0]);
  }

  // If the first part is a plain protocol, we combine it with the next part.
  if (strArray[0].match(/^[^/:]+:\/*$/) && strArray.length > 1) {
    const first = strArray.shift();
    strArray[0] = first + strArray[0];
  }

  // There must be two or three slashes in the file protocol, two slashes in anything else.
  if (strArray[0].match(/^file:\/\/\//)) {
    strArray[0] = strArray[0].replace(/^([^/:]+):\/*/, '$1:///');
  } else {
    strArray[0] = strArray[0].replace(/^([^/:]+):\/*/, '$1://');
  }

  for (let i = 0; i < strArray.length; i++) {
    let component = strArray[i];

    if (typeof component !== 'string') {
      throw new TypeError('Url must be a string. Received ' + component);
    }

    if (component === '') {
      continue;
    }

    if (i > 0) {
      // Removing the starting slashes for each component but the first.
      component = component.replace(/^[\/]+/, '');
    }
    if (i < strArray.length - 1) {
      // Removing the ending slashes for each component but the last.
      component = component.replace(/[\/]+$/, '');
    } else {
      // For the last component we will combine multiple slashes to a single one.
      component = component.replace(/[\/]+$/, '/');
    }

    resultArray.push(component);
  }

  let str = resultArray.join('/');
  // Each input component is now separated by a single slash except the possible first plain protocol part.

  // remove trailing slash before parameters or hash
  str = str.replace(/\/(\?|&|#[^!])/g, '$1');

  // replace ? in parameters with &
  const parts = str.split('?');
  str = parts.shift() + (parts.length > 0 ? '?' : '') + parts.join('&');

  return str;
}

export function urljoin(...args: string[]): string {
  return normalize(args);
}
