import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  Max,
  Min,
  validateSync,
} from 'class-validator';

import { Environment, LogFormat, LogLevel } from './interfaces';

export enum Network {
  Mainnet = 1,
  Goerli = 5,
  Holesky = 17000,
}

export enum WorkingMode {
  Daemon = 'daemon',
  CLI = 'cli',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsEnum(WorkingMode)
  public WORKING_MODE = WorkingMode.Daemon;

  @IsNumber()
  @Min(1025)
  @Max(65535)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public HTTP_PORT = 8080;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @IsEnum(LogFormat)
  LOG_FORMAT: LogFormat = LogFormat.Simple;

  @IsBoolean()
  public DRY_RUN = false;

  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @Max(5000000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public ETH_NETWORK!: Network;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public EL_RPC_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_RESPONSE_TIMEOUT = 60000;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public EL_RPC_MAX_RETRIES = 3;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public CL_API_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_RESPONSE_TIMEOUT = 60000;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public CL_API_MAX_RETRIES = 3;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public KEYSAPI_API_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public KEYSAPI_API_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public KEYSAPI_API_RESPONSE_TIMEOUT = 60000;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public KEYSAPI_API_MAX_RETRIES = 3;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const validatorOptions = { skipMissingProperties: false };
  const errors = validateSync(validatedConfig, validatorOptions);

  if (errors.length > 0) {
    console.error(errors.toString());
    process.exit(1);
  }

  return validatedConfig;
}
