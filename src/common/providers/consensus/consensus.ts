import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { type RootHex, ssz } from '@lodestar/types';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { oraPromise as spinnerFor } from 'ora';

import { DownloadProgress } from './download-progress.js';
import { type SupportedBlock, type SupportedForkKey, getSsz, parseFork } from './forks.js';
import {
  type BeaconHeadersByParentRootResponse,
  type BlockHeaderResponse,
  type BlockId,
  type StateId,
  isDynamicBlockId,
  isDynamicStateId,
} from './response.interface.js';
import { ConfigService } from '../../config/config.service.js';
import { LruCache } from '../../helpers/lru.js';
import { type AppLogger } from '../../logger/app-logger.type.js';
import { PrometheusService, TrackCLRequest } from '../../prometheus/index.js';
import { BaseRestProvider, type RestResponse } from '../base/rest-provider.js';
import { type RequestOptions } from '../base/utils/func.js';

type BlockHeaderResponseJson = {
  root: RootHex;
  canonical: boolean;
  header: unknown;
};

type GenesisResponse = {
  genesis_time: string;
  genesis_validators_root: string;
  genesis_fork_version: string;
};

type BeaconConfig = {
  SLOTS_PER_EPOCH: string;
  SECONDS_PER_SLOT: string;
  CAPELLA_FORK_EPOCH: string;
  FAR_FUTURE_EPOCH: string;
  MAX_EFFECTIVE_BALANCE_ELECTRA: string;
  MIN_ACTIVATION_BALANCE: string;
  ETH1_FOLLOW_DISTANCE: string;
  EPOCHS_PER_ETH1_VOTING_PERIOD: string;
  SLOTS_PER_HISTORICAL_ROOT: string;
  MIN_VALIDATOR_WITHDRAWABILITY_DELAY: string;
};

const isCacheableConsensusId = (id: string | number): boolean => {
  if (typeof id === 'number') return true;
  if (isDynamicBlockId(id)) return false;
  if (isDynamicStateId(id)) return false;
  return true;
};

export interface State {
  bodyBytes: Uint8Array;
  forkName: SupportedForkKey;
}

@Injectable()
export class Consensus extends BaseRestProvider implements OnModuleInit {
  // Max distinct states commonly needed in a single root-processing cycle:
  // epoch current state, epoch previous state, parent state for pre-event proofs,
  // finalized/recent state for historical proofs, and summary state.
  private readonly stateCache = new LruCache<StateId, State>(5, { shouldCache: isCacheableConsensusId });
  private readonly blockInfoCache = new LruCache<BlockId, SupportedBlock>(16, { shouldCache: isCacheableConsensusId });
  private readonly beaconHeaderCache = new LruCache<BlockId, BlockHeaderResponse>(16, {
    shouldCache: isCacheableConsensusId,
  });
  // Only cache fully-populated, finalized responses. A `{finalized: false}` or
  // empty response means "no canonical child known yet" — caching that would
  // permanently shadow the eventual real answer.
  private readonly childHeadersCache = new LruCache<RootHex, BeaconHeadersByParentRootResponse>(16, {
    shouldCacheValue: (resp) => resp.finalized && resp.data.length > 0,
  });

  private readonly endpoints = {
    config: 'eth/v1/config/spec',
    version: 'eth/v1/node/version',
    genesis: 'eth/v1/beacon/genesis',
    blockInfo: (blockId: BlockId): string => `eth/v2/beacon/blocks/${blockId}`,
    beaconHeader: (blockId: BlockId): string => `eth/v1/beacon/headers/${blockId}`,
    beaconHeadersByParentRoot: (parentRoot: RootHex): string => `eth/v1/beacon/headers?parent_root=${parentRoot}`,
    state: (stateId: StateId): string => `eth/v2/debug/beacon/states/${stateId}`,
  };

  public genesisTimestamp: number;
  public beaconConfig: BeaconConfig;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
    @Optional() protected readonly prometheus: PrometheusService,
    @Optional() protected readonly progress: DownloadProgress,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('CL_API_URLS') as Array<string>,
      config.get('CL_API_RESPONSE_TIMEOUT_MS'),
      config.get('CL_API_MAX_RETRIES'),
      config.get('CL_API_RETRY_DELAY_MS'),
      logger,
      prometheus,
    );
  }

  public async onModuleInit(): Promise<void> {
    this.logger.log(`Getting genesis timestamp`);
    const genesis = await this.getGenesis();
    this.genesisTimestamp = Number(genesis.genesis_time);
    this.beaconConfig = await this.getConfig();
  }

  public slotToTimestamp(slot: number): number {
    return this.genesisTimestamp + slot * Number(this.beaconConfig.SECONDS_PER_SLOT);
  }

  public epochToSlot(epoch: number): number {
    return epoch * Number(this.beaconConfig.SLOTS_PER_EPOCH);
  }

  public slotToEpoch(slot: number): number {
    return Math.floor(slot / Number(this.beaconConfig.SLOTS_PER_EPOCH));
  }

  public async getConfig(): Promise<BeaconConfig> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.config));
    const jsonBody = (await body.json()) as { data: BeaconConfig };
    return jsonBody.data;
  }

  public async getGenesis(): Promise<GenesisResponse> {
    const { body } = await this.retryRequest((baseUrl) => this.baseGet(baseUrl, this.endpoints.genesis));
    const jsonBody = (await body.json()) as { data: GenesisResponse };
    return jsonBody.data;
  }

  public async getBlockInfo(blockId: BlockId): Promise<SupportedBlock> {
    return await this.blockInfoCache.getOrFetch(blockId, async () => {
      const { body, headers } = await this.retryRequest((baseUrl) =>
        this.baseGet(baseUrl, this.endpoints.blockInfo(blockId)),
      );
      const forkName = parseFork(headers['eth-consensus-version'] as string);
      const jsonBody = (await body.json()) as { data: { message: JSON } };
      return getSsz(forkName).BeaconBlock.fromJson(jsonBody.data.message);
    });
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    return await this.beaconHeaderCache.getOrFetch(blockId, async () => {
      const { body } = await this.retryRequest((baseUrl) =>
        this.baseGet(baseUrl, this.endpoints.beaconHeader(blockId)),
      );
      const jsonBody = (await body.json()) as { data: BlockHeaderResponseJson };
      return {
        ...jsonBody.data,
        header: ssz.phase0.SignedBeaconBlockHeader.fromJson(jsonBody.data.header),
      };
    });
  }

  public async getBeaconHeadersByParentRoot(parentRoot: RootHex): Promise<BeaconHeadersByParentRootResponse> {
    return await this.childHeadersCache.getOrFetch(parentRoot, async () => {
      const { body } = await this.retryRequest((baseUrl) =>
        this.baseGet(baseUrl, this.endpoints.beaconHeadersByParentRoot(parentRoot)),
      );
      const jsonBody = (await body.json()) as { finalized: boolean; data: BlockHeaderResponseJson[] };
      return {
        finalized: jsonBody.finalized,
        data: jsonBody.data.map((item) => ({
          ...item,
          header: ssz.phase0.SignedBeaconBlockHeader.fromJson(item.header),
        })),
      };
    });
  }

  public async getState(stateId: StateId, signal?: AbortSignal): Promise<State> {
    return await this.stateCache.getOrFetch(stateId, async () => this.fetchState(stateId, signal));
  }

  private async fetchState(stateId: StateId, signal?: AbortSignal): Promise<State> {
    const requestPromise = this.retryRequest(async (baseUrl) =>
      this.baseGet(baseUrl, this.endpoints.state(stateId), {
        signal,
        headers: { accept: 'application/octet-stream' },
      }),
    );
    if (this.progress) {
      spinnerFor(requestPromise, { text: `Getting state response for state id [${stateId}]` });
    } else {
      this.logger.log(`Getting state response for state id [${stateId}]`);
    }
    const { body, headers } = await requestPromise;
    this.progress?.show('State downloading', { body, headers });
    const forkName = parseFork(headers['eth-consensus-version'] as string);
    const bodyBytes = await body.bytes();
    return { bodyBytes, forkName };
  }

  @TrackCLRequest
  protected baseGet(baseUrl: string, endpoint: string, options?: RequestOptions): Promise<RestResponse> {
    return super.baseGet(baseUrl, endpoint, options);
  }
}
