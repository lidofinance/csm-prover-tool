import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { connectTo } from 'stream-json/Assembler';
import { IncomingHttpHeaders } from 'undici/types/header';
import BodyReadable from 'undici/types/readable';

import {
  BlockHeaderResponse,
  BlockId,
  BlockInfoResponse,
  GenesisResponse,
  RootHex,
  StateId,
  StateValidatorResponse,
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

  public async onModuleInit(): Promise<any> {
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
    return (await this.baseGet<any>(this.mainUrl, this.endpoints.genesis)).data as GenesisResponse;
  }

  public async getBlockInfo(blockId: BlockId): Promise<BlockInfoResponse> {
    return (await this.baseGet<any>(this.mainUrl, this.endpoints.blockInfo(blockId))).data as BlockInfoResponse;
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    return (await this.baseGet<any>(this.mainUrl, this.endpoints.beaconHeader(blockId))).data as BlockHeaderResponse;
  }

  public async getBeaconHeadersByParentRoot(
    parentRoot: RootHex,
  ): Promise<{ finalized: boolean; data: BlockHeaderResponse[] }> {
    return (await this.baseGet(this.mainUrl, this.endpoints.beaconHeadersByParentRoot(parentRoot))) as {
      finalized: boolean;
      data: BlockHeaderResponse[];
    };
  }

  public async getValidators(stateId: StateId, signal?: AbortSignal): Promise<StateValidatorResponse[]> {
    const resp: { body: BodyReadable; headers: IncomingHttpHeaders } = await this.baseGet(
      this.mainUrl,
      this.endpoints.validators(stateId),
      {
        streamed: true,
        signal,
      },
    );
    // Progress bar
    // TODO: Enable for CLI only
    //this.progress.show('Validators from state', resp);
    // Data processing
    const pipeline = chain([resp.body, parser()]);
    return await new Promise((resolve) => {
      connectTo(pipeline).on('done', (asm) => resolve(asm.current.data));
    });
  }

  public async getState(stateId: StateId, signal?: AbortSignal): Promise<any> {
    const { body } = await this.baseGet<{ body: BodyReadable; headers: IncomingHttpHeaders }>(
      this.mainUrl,
      this.endpoints.state(stateId),
      {
        streamed: true,
        signal,
      },
    );
    // Progress bar
    // TODO: Enable for CLI only
    //this.progress.show(`State [${stateId}]`, resp);
    // Data processing
    const pipeline = chain([body, parser()]);
    return await new Promise((resolve) => {
      connectTo(pipeline).on('done', (asm) => resolve(asm.current));
    });
  }

  public async getStateView(stateId: StateId, signal?: AbortSignal) {
    const { body, headers } = await this.baseGet<{ body: BodyReadable; headers: IncomingHttpHeaders }>(
      this.mainUrl,
      this.endpoints.state(stateId),
      {
        streamed: true,
        signal,
        headers: { accept: 'application/octet-stream' },
      },
    );
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
