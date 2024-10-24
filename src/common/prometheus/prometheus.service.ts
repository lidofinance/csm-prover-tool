import { LOGGER_PROVIDER, LoggerService } from '@lido-nestjs/logger';
import { Inject, Injectable } from '@nestjs/common';
import { Metrics, getOrCreateMetric } from '@willsoto/nestjs-prometheus';
import { join } from 'lodash';

import { Metric, Options } from './interfaces';
import {
  METRICS_PREFIX,
  METRIC_BUILD_INFO,
  METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT,
  METRIC_OUTGOING_CL_REQUESTS_COUNT,
  METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS,
  METRIC_OUTGOING_EL_REQUESTS_COUNT,
  METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS,
  METRIC_OUTGOING_KEYSAPI_REQUESTS_COUNT,
  METRIC_OUTGOING_KEYSAPI_REQUESTS_DURATION_SECONDS,
  METRIC_TASK_DURATION_SECONDS,
  METRIC_TASK_RESULT_COUNT,
  METRIC_TRANSACTION_COUNTER,
} from './prometheus.constants';
import { ConfigService } from '../config/config.service';
import { WorkingMode } from '../config/env.validation';

export enum RequestStatus {
  COMPLETE = 'complete',
  ERROR = 'error',
}

enum TaskStatus {
  COMPLETE = 'complete',
  ERROR = 'error',
}

export function requestLabels(apiUrl: string, subUrl: string) {
  const targetName = new URL(apiUrl).hostname;
  const reqName = join(
    subUrl
      .split('?')[0]
      .split('/')
      .map((p) => {
        if (p.includes('0x') || +p) return '{param}';
        return p;
      }),
    '/',
  );
  return [targetName, reqName];
}

@Injectable()
export class PrometheusService {
  private prefix = METRICS_PREFIX;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    private config: ConfigService,
  ) {}

  public getOrCreateMetric<T extends Metrics, L extends string>(type: T, options: Options<L>): Metric<T, L> {
    const nameWithPrefix = this.prefix + options.name;

    return getOrCreateMetric(type, {
      ...options,
      name: nameWithPrefix,
    }) as Metric<T, L>;
  }

  public buildInfo = this.getOrCreateMetric('Counter', {
    name: METRIC_BUILD_INFO,
    help: 'Build information',
    labelNames: ['name', 'version', 'commit', 'branch', 'env', 'network'],
  });

  public outgoingELRequestsDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_OUTGOING_EL_REQUESTS_DURATION_SECONDS,
    help: 'Duration of outgoing execution layer requests',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60],
    labelNames: ['name', 'target'] as const,
  });

  public outgoingELRequestsCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_OUTGOING_EL_REQUESTS_COUNT,
    help: 'Count of outgoing execution layer requests',
    labelNames: ['name', 'target', 'status'] as const,
  });

  public outgoingCLRequestsDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_OUTGOING_CL_REQUESTS_DURATION_SECONDS,
    help: 'Duration of outgoing consensus layer requests',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60],
    labelNames: ['name', 'target'] as const,
  });

  public outgoingCLRequestsCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_OUTGOING_CL_REQUESTS_COUNT,
    help: 'Count of outgoing consensus layer requests',
    labelNames: ['name', 'target', 'status', 'code'] as const,
  });

  public outgoingKeysAPIRequestsDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_OUTGOING_KEYSAPI_REQUESTS_DURATION_SECONDS,
    help: 'Duration of outgoing KeysAPI requests',
    buckets: [0.01, 0.1, 0.5, 1, 2, 5, 15, 30, 60],
    labelNames: ['name', 'target'] as const,
  });

  public outgoingKeysAPIRequestsCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_OUTGOING_KEYSAPI_REQUESTS_COUNT,
    help: 'Count of outgoing KeysAPI requests',
    labelNames: ['name', 'target', 'status', 'code'] as const,
  });

  public taskDuration = this.getOrCreateMetric('Histogram', {
    name: METRIC_TASK_DURATION_SECONDS,
    help: 'Duration of task execution',
    buckets: [5, 15, 30, 60, 120, 180, 240, 300, 400, 600],
    labelNames: ['name'],
  });

  public taskCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_TASK_RESULT_COUNT,
    help: 'Count of passed or failed tasks',
    labelNames: ['name', 'status'],
  });

  public highGasFeeInterruptionsCount = this.getOrCreateMetric('Counter', {
    name: METRIC_HIGH_GAS_FEE_INTERRUPTIONS_COUNT,
    help: 'Count of high gas fee interruptions',
  });

  public transactionCount = this.getOrCreateMetric('Gauge', {
    name: METRIC_TRANSACTION_COUNTER,
    help: 'Count of transactions',
    labelNames: ['status'],
  });
}

export function TrackCLRequest(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalValue = descriptor.value;
  descriptor.value = function (...args: any[]) {
    if (this.config.get('WORKING_MODE') == WorkingMode.CLI) {
      return originalValue.apply(this, args);
    }
    if (!this.prometheus) throw Error(`'${this.constructor.name}' class object must contain 'prometheus' property`);
    const [apiUrl, subUrl] = args;
    const [targetName, reqName] = requestLabels(apiUrl, subUrl);
    const stop = this.prometheus.outgoingCLRequestsDuration.startTimer({
      name: reqName,
      target: targetName,
    });
    return originalValue
      .apply(this, args)
      .then((r: any) => {
        this.prometheus.outgoingCLRequestsCount.inc({
          name: reqName,
          target: targetName,
          status: RequestStatus.COMPLETE,
          code: 200,
        });
        return r;
      })
      .catch((e: any) => {
        this.prometheus.outgoingCLRequestsCount.inc({
          name: reqName,
          target: targetName,
          status: RequestStatus.ERROR,
          code: e.statusCode,
        });
        throw e;
      })
      .finally(() => stop());
  };
}

export function TrackKeysAPIRequest(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalValue = descriptor.value;
  descriptor.value = function (...args: any[]) {
    if (!this.prometheus) throw Error(`'${this.constructor.name}' class object must contain 'prometheus' property`);
    const [apiUrl, subUrl] = args;
    const [targetName, reqName] = requestLabels(apiUrl, subUrl);
    const stop = this.prometheus.outgoingKeysAPIRequestsDuration.startTimer({
      name: reqName,
      target: targetName,
    });
    return originalValue
      .apply(this, args)
      .then((r: any) => {
        this.prometheus.outgoingKeysAPIRequestsCount.inc({
          name: reqName,
          target: targetName,
          status: RequestStatus.COMPLETE,
          code: 200,
        });
        return r;
      })
      .catch((e: any) => {
        this.prometheus.outgoingKeysAPIRequestsCount.inc({
          name: reqName,
          target: targetName,
          status: RequestStatus.ERROR,
          code: e.statusCode,
        });
        throw e;
      })
      .finally(() => stop());
  };
}

export function TrackTask(name: string) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalValue = descriptor.value;

    descriptor.value = function (...args: any[]) {
      // "this" here will refer to the class instance
      if (!this.prometheus) throw Error(`'${this.constructor.name}' class object must contain 'prometheus' property`);
      const stop = this.prometheus.taskDuration.startTimer({
        name: name,
      });
      this.logger.debug(`Task '${name}' in progress`);
      return originalValue
        .apply(this, args)
        .then((r: any) => {
          this.prometheus.taskCount.inc({
            name: name,
            status: TaskStatus.COMPLETE,
          });
          return r;
        })
        .catch((e: Error) => {
          this.logger.error(`Task '${name}' ended with an error`, e.stack);
          this.prometheus.taskCount.inc({
            name: name,
            status: TaskStatus.ERROR,
          });
          throw e;
        })
        .finally(() => {
          const duration = stop();
          const used = process.memoryUsage().heapUsed / 1024 / 1024;
          this.logger.debug(`Task '${name}' is complete. Used MB: ${used}. Duration: ${duration}`);
        });
    };
  };
}

// Only for Workers service. The first argument in tracked runner should be the name of the worker
export function TrackWorker() {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalValue = descriptor.value;

    descriptor.value = function (...args: any[]) {
      // "this" here will refer to the class instance
      if (!this.prometheus) throw Error(`'${this.constructor.name}' class object must contain 'prometheus' property`);
      const name = `run-worker-${args[0]}`;
      const stop = this.prometheus.taskDuration.startTimer({
        name: name,
      });
      this.logger.debug(`Worker '${name}' in progress`);
      return originalValue
        .apply(this, args)
        .then((r: any) => {
          this.prometheus.taskCount.inc({
            name: name,
            status: TaskStatus.COMPLETE,
          });
          return r;
        })
        .catch((e: Error) => {
          this.logger.error(`Worker '${name}' ended with an error`, e.stack);
          this.prometheus.taskCount.inc({
            name: name,
            status: TaskStatus.ERROR,
          });
          throw e;
        })
        .finally(() => {
          const duration = stop();
          this.logger.debug(`Worker '${name}' is complete. Duration: ${duration}`);
        });
    };
  };
}
