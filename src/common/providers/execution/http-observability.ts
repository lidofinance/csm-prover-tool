import { type AppLogger } from '../../logger/app-logger.type.js';
import { type PrometheusService, RequestStatus } from '../../prometheus/index.js';

export function instrumentedFetch(target: string, prometheus: PrometheusService): typeof fetch {
  const name = 'batch';
  return async (input, init) => {
    const stop = prometheus.outgoingELRequestsDuration.startTimer({ name, target });
    try {
      const response = await fetch(input, init);
      const status = response.ok ? RequestStatus.COMPLETE : RequestStatus.ERROR;
      prometheus.outgoingELRequestsCount.inc({ name, target, status });
      return response;
    } catch (e) {
      prometheus.outgoingELRequestsCount.inc({ name, target, status: RequestStatus.ERROR });
      throw e;
    } finally {
      stop();
    }
  };
}

const TRACE_HEADERS = ['x-drpc-trace-id', 'cf-ray'];

async function readErrors(response: Response, hostname: string, ids: string, logger: AppLogger): Promise<void> {
  try {
    const text = await response.clone().text();
    if (!text.includes('"error"')) return;
    const parsed = JSON.parse(text);
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!item?.error) continue;
      const { code, message } = item.error;
      logger.warn(`EL ${hostname} returned error ${JSON.stringify({ code, message })} (${ids})`);
    }
  } catch {
    // a trace log must never change the outcome of the request
  }
}

// Trace ids let a provider find the request behind an error, even one fallback recovered from; viem awaits the hook, so it must not block
export function logTracedErrors(hostname: string, logger: AppLogger): (response: Response) => void {
  return (response) => {
    const ids = TRACE_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [`${name}: ${value}`] : [];
    }).join(', ');
    if (!ids) return;
    if (!response.ok) {
      logger.warn(`EL ${hostname} answered HTTP ${response.status} (${ids})`);
      return;
    }
    void readErrors(response, hostname, ids, logger);
  };
}
