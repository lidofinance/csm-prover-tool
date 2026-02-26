import { parentPort } from 'node:worker_threads';

class ParentLoggerMessage {
  __class: string;
  level: string;
  message: string;

  constructor(level: string, message: string) {
    this.__class = ParentLoggerMessage.name;
    this.level = level;
    this.message = message;
  }

  // override `instanceof` behavior to allow simple type checking
  static get [Symbol.hasInstance]() {
    return function (instance: any) {
      return instance.__class === ParentLoggerMessage.name;
    };
  }
}

export class WorkerLogger {
  public static warn(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('warn', message));
  }

  public static log(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('log', message));
  }

  public static error(message: string): void {
    parentPort?.postMessage(new ParentLoggerMessage('error', message));
  }
}

export { ParentLoggerMessage };
