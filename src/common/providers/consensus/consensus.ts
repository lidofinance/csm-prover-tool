import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';

import {
  BlockHeaderResponse,
  BlockId,
  BlockInfoResponse,
  GenesisResponse,
  RootHex,
  StateId,
} from './response.interface';
import { ConfigService } from '../../config/config.service';
import { PrometheusService } from '../../prometheus/prometheus.service';
import { DownloadProgress } from '../../utils/download-progress/download-progress';
import { BaseRestProvider } from '../base/rest-provider';

let ssz: typeof import('@lodestar/types').ssz;
let ForkName: typeof import('@lodestar/params').ForkName;

@Injectable()
export class Consensus extends BaseRestProvider implements OnModuleInit {
  private readonly endpoints = {
    version: 'eth/v1/node/version',
    genesis: 'eth/v1/beacon/genesis',
    blockInfo: (blockId: BlockId): string => `eth/v2/beacon/blocks/${blockId}`,
    beaconHeader: (blockId: BlockId): string => `eth/v1/beacon/headers/${blockId}`,
    beaconHeadersByParentRoot: (parentRoot: RootHex): string => `eth/v1/beacon/headers?parent_root=${parentRoot}`,
    validators: (stateId: StateId): string => `eth/v1/beacon/states/${stateId}/validators`,
    state: (stateId: StateId): string => `eth/v2/debug/beacon/states/${stateId}`,
  };

  public genesisTimestamp: number;
  // TODO: configurable
  public SLOTS_PER_EPOCH: number = 32;
  public SECONDS_PER_SLOT: number = 12;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    protected readonly config: ConfigService,
    protected readonly progress: DownloadProgress,
  ) {
    super(
      config.get('CL_API_URLS') as Array<string>,
      config.get('CL_API_RESPONSE_TIMEOUT'),
      config.get('CL_API_MAX_RETRIES'),
      logger,
      prometheus,
    );
  }

  public async onModuleInit(): Promise<void> {
    // ugly hack to import ESModule to CommonJS project
    ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
    this.logger.log(`Getting genesis timestamp`);
    const resp = await this.getGenesis();
    this.genesisTimestamp = Number(resp.genesis_time);
  }

  public slotToTimestamp(slot: number): number {
    return this.genesisTimestamp + slot * this.SECONDS_PER_SLOT;
  }

  public async getGenesis(): Promise<GenesisResponse> {
    const resp = await this.baseJsonGet<{ data: GenesisResponse }>(this.mainUrl, this.endpoints.genesis);
    return resp.data;
  }

  public async getBlockInfo(blockId: BlockId): Promise<BlockInfoResponse> {
    const resp = await this.baseJsonGet<{ data: BlockInfoResponse }>(this.mainUrl, this.endpoints.blockInfo(blockId));
    return resp.data;
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    const resp = await this.baseJsonGet<{ data: BlockHeaderResponse }>(
      this.mainUrl,
      this.endpoints.beaconHeader(blockId),
    );
    return resp.data;
  }

  public async getBeaconHeadersByParentRoot(
    parentRoot: RootHex,
  ): Promise<{ finalized: boolean; data: BlockHeaderResponse[] }> {
    return await this.baseJsonGet<{ finalized: boolean; data: BlockHeaderResponse[] }>(
      this.mainUrl,
      this.endpoints.beaconHeadersByParentRoot(parentRoot),
    );
  }

  public async getStateView(stateId: StateId, signal?: AbortSignal) {
    const { body, headers } = await this.baseStreamedGet(this.mainUrl, this.endpoints.state(stateId), {
      signal,
      headers: { accept: 'application/octet-stream' },
    });
    const version = headers['eth-consensus-version'] as keyof typeof ForkName;
    // Progress bar
    // TODO: Enable for CLI only
    //this.progress.show(`State [${stateId}]`, resp);
    // Data processing
    const bodyBites = new Uint8Array(await body.arrayBuffer());
    // TODO: high memory usage
    return ssz.allForks[version].BeaconState.deserializeToView(bodyBites);
  }
}
