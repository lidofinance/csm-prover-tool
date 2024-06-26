import { ConfigService as ConfigServiceSource } from '@nestjs/config';

import { EnvironmentVariables } from './env.validation';

export class ConfigService extends ConfigServiceSource<EnvironmentVariables> {
  /**
   * List of env variables that should be hidden
   */
  public get secrets(): string[] {
    return [...this.get('EL_RPC_URLS'), ...this.get('CL_API_URLS'), ...(this.get('KEYSAPI_API_URLS') ?? [])];
  }

  public get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return super.get(key, { infer: true }) as EnvironmentVariables[T];
  }
}
