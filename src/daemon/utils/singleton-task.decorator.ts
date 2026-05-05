export function SingletonTask() {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const flagName = `_${propertyKey}Running`;
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: any[]) {
      if (!this.logger) {
        throw new Error(`Logger is not defined for ${propertyKey} in ${target.constructor.name}`);
      }
      if (this[flagName]) {
        this.logger.warn(`🔄 Method ${propertyKey} is already running, skipping execution`);
        return Promise.resolve();
      }

      this[flagName] = true;

      return originalMethod.apply(this, args).finally(() => {
        this[flagName] = false;
      });
    };
  };
}
