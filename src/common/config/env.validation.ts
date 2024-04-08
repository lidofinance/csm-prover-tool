import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsEnum(WorkingMode)
  public WORKING_MODE = WorkingMode.Daemon;

  @IsOptional()
  @IsString()
  public START_ROOT?: string;

  @IsNotEmpty()
  @IsString()
  public CSM_ADDRESS: string;

  @IsNotEmpty()
  @IsString()
  public VERIFIER_ADDRESS: string;

  @IsNotEmpty()
  @IsString()
  @ValidateIf((vars) => !vars.DRY_RUN)
  public TX_SIGNER_PRIVATE_KEY: string;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_MIN_GAS_PRIORITY_FEE = 50_000_000; // 0.05 gwei

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_MAX_GAS_PRIORITY_FEE = 10_000_000_000; // 10 gwei

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_PRIORITY_FEE_PERCENTILE = 25;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_DAYS = 1;

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_PERCENTILE = 20;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public TX_GAS_LIMIT = 1_000_000;

  @IsNumber()
  @Min(30 * MINUTE)
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public KEYS_INDEXER_RUNNING_PERIOD_MS: number = 3 * HOUR;

  @IsNumber()
  @Min(384000) // epoch time in ms
  @Transform(({ value }) => parseInt(value, 10), { toClassOnly: true })
  public KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD_MS: number = 8 * HOUR;

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
  @Transform(({ value }) => toBoolean(value), { toClassOnly: true })
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
  public EL_RPC_RESPONSE_TIMEOUT_MS = MINUTE;

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
  public CL_API_RESPONSE_TIMEOUT_MS = MINUTE;

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
  public KEYSAPI_API_RESPONSE_TIMEOUT_MS = MINUTE;

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

const toBoolean = (value: any): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return !!value;
  }

  if (!(typeof value === 'string')) {
    return false;
  }

  switch (value.toLowerCase().trim()) {
    case 'true':
    case 'yes':
    case '1':
      return true;
    case 'false':
    case 'no':
    case '0':
    case null:
      return false;
    default:
      return false;
  }
};
