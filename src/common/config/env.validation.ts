import { writeSync } from 'node:fs';

import { Transform, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsEthereumAddress,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  getMetadataStorage,
  validateSync,
} from 'class-validator';
import type { Address, Hex } from 'viem';

import { Environment, LogFormat, LogLevel } from './interfaces/environment.interface.js';

export enum Network {
  Mainnet = 1,
  Goerli = 5,
  Holesky = 17000,
}

export enum WorkingMode {
  Daemon = 'daemon',
  CLI = 'cli',
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsEnum(WorkingMode)
  public WORKING_MODE = WorkingMode.Daemon;

  @IsOptional()
  @IsString()
  public START_ROOT?: string;

  // User-Agent for outgoing requests. Unset — derived from build info, empty — not sent.
  @IsOptional()
  @IsString()
  public HTTP_USER_AGENT?: string;

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public ROOTS_PROCESSING_LAG_SLOTS = 0;

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public ROOTS_ORPHAN_REWIND_EPOCHS = 1;

  @IsNotEmpty()
  @IsEthereumAddress()
  public STAKING_MODULE_ADDRESS: Address;

  @IsOptional()
  @IsNotEmpty()
  @IsEthereumAddress()
  public VERIFIER_ADDRESS?: Address;

  @IsOptional()
  @IsNotEmpty()
  @IsEthereumAddress()
  public STRIKES_ADDRESS?: Address;

  @IsOptional()
  @IsNotEmpty()
  @IsEthereumAddress()
  public EXIT_PENALTIES_ADDRESS?: Address;

  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  @Transform(({ value }) => toPrefixedHex(value), { toClassOnly: true })
  @ValidateIf((vars) => !vars.DRY_RUN || vars.TX_SIGNER_PRIVATE_KEY)
  public TX_SIGNER_PRIVATE_KEY: Hex;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_MIN_GAS_PRIORITY_FEE = 50_000_000; // 0.05 gwei

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_MAX_GAS_PRIORITY_FEE = 10_000_000_000; // 10 gwei

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_GAS_PRIORITY_FEE_PERCENTILE = 25;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_DAYS = 1;

  @IsNumber()
  @Max(100)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_GAS_FEE_HISTORY_PERCENTILE = 50;

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toNumber(value), { toClassOnly: true })
  public TX_MIN_BASE_FEE_GWEI = 1;

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toNumber(value), { toClassOnly: true })
  public TX_MAX_BASE_FEE_GWEI = 50;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_GAS_LIMIT = 3_000_000;

  @IsNumber()
  @Min(0)
  @Max(100)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_GAS_LIMIT_BUFFER_PERCENT = 20;

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_HIGH_GAS_FEE_MAX_RETRIES = 13;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_HIGH_GAS_FEE_RETRY_DELAY_MS = 60_000;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_MINING_WAITING_TIMEOUT_MS = 3 * MINUTE_MS;

  @IsNumber()
  @Min(MINUTE_MS)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public WORKER_TIMEOUT_MS = 30 * MINUTE_MS;

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public WORKER_MAX_OLD_GENERATION_SIZE_MB = 3072;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_CONFIRMATIONS = 1;

  @IsNumber()
  @Min(30 * MINUTE_MS)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public KEYS_INDEXER_RUNNING_PERIOD_MS: number = 3 * HOUR_MS;

  @IsNumber()
  @Min(1025)
  @Max(65535)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
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
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public CHAIN_ID!: Network;

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public EL_RPC_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public EL_RPC_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public EL_RPC_MAX_RETRIES = 3;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  // NOTE: Returns to the first EL RPC URL this long after switching to a fallback
  public EL_RPC_RESET_INTERVAL_MS = 12 * MINUTE_MS; // a bit less than CL finalization time

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  // Max JSON-RPC calls coalesced into one batched HTTP request. Lower if the provider rejects large batches.
  public EL_RPC_MAX_BATCH_SIZE = 25;

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  // Window (ms) to accumulate calls into a batch before sending.
  public EL_RPC_BATCH_AGGREGATION_WAIT_MS = 10;

  @IsArray()
  @IsString({ each: true })
  @Matches(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, { each: true })
  @Transform(({ value }) => toStringList(value), { toClassOnly: true })
  public EL_TRACE_HEADERS: string[] = ['x-drpc-trace-id', 'cf-ray'];

  @IsArray()
  @ArrayMinSize(1)
  @Transform(({ value }) => value.split(','))
  public CL_API_URLS!: string[];

  @IsInt()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public CL_API_RETRY_DELAY_MS = 500;

  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public CL_API_RESPONSE_TIMEOUT_MS = MINUTE_MS;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public CL_API_MAX_RETRIES = 3;

  @IsNumber()
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE = 10;

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public STRIKES_MAX_REQUEST_FEE_GWEI = 6000;

  @IsNumber()
  @Min(1)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public BALANCE_PROOF_MIN_DELTA_GWEI = 512 * 1_000_000_000; // 512 ETH

  @IsNumber()
  @Min(0)
  @Transform(({ value }) => toInteger(value), { toClassOnly: true })
  public BALANCE_PROOF_TOPUP_STEP_GWEI = 2 * 1_000_000_000; // 2 ETH

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Transform(({ value }) => toIntArray(value), { toClassOnly: true })
  public DAEMON_NODE_OPERATOR_IDS?: number[];
}

export const ENV_VARIABLE_KEYS = [
  ...new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(EnvironmentVariables, '', false, false)
      .map((meta) => meta.propertyName),
  ),
] as (keyof EnvironmentVariables)[];

// The app logger is built from this config; `writeSync` survives the `process.exit` below.
const logStartup = (level: 'warn' | 'error', message: string): void => {
  const json = process.env.LOG_FORMAT?.toLowerCase().trim() === LogFormat.JSON;
  writeSync(2, `${json ? JSON.stringify({ level, message }) : `${level}: ${message}`}\n`);
};

export function validate(config: Record<string, unknown>) {
  if (config.CSM_ADDRESS) {
    logStartup('warn', 'CSM_ADDRESS is deprecated, use STAKING_MODULE_ADDRESS instead');
    if (!config.STAKING_MODULE_ADDRESS) {
      config.STAKING_MODULE_ADDRESS = config.CSM_ADDRESS;
    }
  }

  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const validatorOptions = { skipMissingProperties: false };
  const errors = validateSync(validatedConfig, validatorOptions);

  if (errors.length > 0) {
    // The last flag prints constraint messages instead of names.
    logStartup('error', errors.map((e) => e.toString(false, false, '', true)).join(''));
    process.exit(1);
  }

  if (
    validatedConfig.TX_MAX_BASE_FEE_GWEI > 0 &&
    validatedConfig.TX_MIN_BASE_FEE_GWEI > validatedConfig.TX_MAX_BASE_FEE_GWEI
  ) {
    logStartup(
      'error',
      `TX_MIN_BASE_FEE_GWEI (${validatedConfig.TX_MIN_BASE_FEE_GWEI}) must not exceed TX_MAX_BASE_FEE_GWEI (${validatedConfig.TX_MAX_BASE_FEE_GWEI})`,
    );
    process.exit(1);
  }

  return validatedConfig;
}

const toBoolean = (value: any): unknown => {
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
    case '':
      return false;
    default:
      // Return as is to fail `@IsBoolean()` instead of silently coercing a typo to `false`.
      return value;
  }
};

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }

  if (typeof value !== 'string') {
    return NaN;
  }

  const trimmed = value.trim();
  if (!/^[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?$/.test(trimmed)) {
    return NaN;
  }
  return Number(trimmed.replaceAll('_', ''));
};

const toInteger = (value: unknown): number => {
  const parsed = toNumber(value);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
};

const toPrefixedHex = (value: unknown): unknown =>
  typeof value === 'string' && value && !value.startsWith('0x') ? `0x${value}` : value;

const toStringList = (value: unknown): unknown =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : value;

const toIntArray = (value: unknown): number[] | undefined | unknown => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(',').map((part) => part.trim());
  // Return as is to fail `@IsArray()`: `Number('')` would silently authorize node operator 0.
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return value;
  }
  return [...new Set(parts.map(Number))];
};
