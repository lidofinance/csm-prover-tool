import { ConfigService as ConfigServiceSource } from '@nestjs/config';

import { ENV_VARIABLE_KEYS, type EnvironmentVariables } from './env.validation.js';

export class ConfigService extends ConfigServiceSource<EnvironmentVariables> {
  /**
   * List of env variables that should be hidden
   */
  public get secrets(): string[] {
    return [
      this.get('TX_SIGNER_PRIVATE_KEY'),
      ...this.get('EL_RPC_URLS'),
      ...this.get('CL_API_URLS'),
      ...(this.get('KEYSAPI_API_URLS') ?? []),
    ].filter(Boolean);
  }

  public get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return super.get(key, { infer: true }) as EnvironmentVariables[T];
  }

  /** App config snapshot for the startup ENV dump; secret values are masked by the log transport (see `secrets`). */
  public snapshot(): Record<string, unknown> {
    const config = Object.fromEntries(ENV_VARIABLE_KEYS.map((key) => [key, this.get(key)]));
    return { ...config, NODE_OPTIONS: process.env.NODE_OPTIONS };
  }
}
