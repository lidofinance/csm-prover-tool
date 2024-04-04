import { ContainerTreeViewType } from '@chainsafe/ssz/lib/view/container';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit, Optional } from '@nestjs/common';
import ora from 'ora';

import {
  BeaconConfig,
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
let anySsz: typeof ssz.phase0 | typeof ssz.altair | typeof ssz.bellatrix | typeof ssz.capella | typeof ssz.deneb;
let ForkName: typeof import('@lodestar/params').ForkName;

@Injectable()
export class Consensus extends BaseRestProvider implements OnModuleInit {
  private readonly endpoints = {
    config: 'eth/v1/config/spec',
    version: 'eth/v1/node/version',
    genesis: 'eth/v1/beacon/genesis',
    blockInfo: (blockId: BlockId): string => `eth/v2/beacon/blocks/${blockId}`,
    beaconHeader: (blockId: BlockId): string => `eth/v1/beacon/headers/${blockId}`,
    beaconHeadersByParentRoot: (parentRoot: RootHex): string => `eth/v1/beacon/headers?parent_root=${parentRoot}`,
    validators: (stateId: StateId): string => `eth/v1/beacon/states/${stateId}/validators`,
    state: (stateId: StateId): string => `eth/v2/debug/beacon/states/${stateId}`,
  };

  public genesisTimestamp: number;
  public beaconConfig: BeaconConfig;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    @Optional() protected readonly prometheus: PrometheusService,
    @Optional() protected readonly progress: DownloadProgress,
    protected readonly config: ConfigService,
  ) {
    super(
      config.get('CL_API_URLS') as Array<string>,
      config.get('CL_API_RESPONSE_TIMEOUT_MS'),
      config.get('CL_API_MAX_RETRIES'),
      logger,
      prometheus,
    );
  }

  public async onModuleInit(): Promise<void> {
    // ugly hack to import ESModule to CommonJS project
    ssz = await eval(`import('@lodestar/types').then((m) => m.ssz)`);
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
    const { body } = await this.baseGet(this.mainUrl, this.endpoints.config);
    const jsonBody = (await body.json()) as { data: BeaconConfig };
    return jsonBody.data;
  }

  public async getGenesis(): Promise<GenesisResponse> {
    const { body } = await this.baseGet(this.mainUrl, this.endpoints.genesis);
    const jsonBody = (await body.json()) as { data: GenesisResponse };
    return jsonBody.data;
  }

  public async getBlockInfo(blockId: BlockId): Promise<BlockInfoResponse> {
    const { body } = await this.baseGet(this.mainUrl, this.endpoints.blockInfo(blockId));
    const jsonBody = (await body.json()) as { data: BlockInfoResponse };
    return jsonBody.data;
  }

  public async getBeaconHeader(blockId: BlockId): Promise<BlockHeaderResponse> {
    const { body } = await this.baseGet(this.mainUrl, this.endpoints.beaconHeader(blockId));
    const jsonBody = (await body.json()) as { data: BlockHeaderResponse };
    return jsonBody.data;
  }

  public async getBeaconHeadersByParentRoot(
    parentRoot: RootHex,
  ): Promise<{ finalized: boolean; data: BlockHeaderResponse[] }> {
    const { body } = await this.baseGet(this.mainUrl, this.endpoints.beaconHeadersByParentRoot(parentRoot));
    return (await body.json()) as { finalized: boolean; data: BlockHeaderResponse[] };
  }

  public async getState(
    stateId: StateId,
    signal?: AbortSignal,
  ): Promise<{ bodyBytes: Uint8Array; forkName: keyof typeof ForkName }> {
    const requestPromise = this.baseGet(this.mainUrl, this.endpoints.state(stateId), {
      signal,
      headers: { accept: 'application/octet-stream' },
    });
    if (this.progress) {
      ora.promise(requestPromise, { text: `Getting state response for state id [${stateId}]` });
    } else {
      this.logger.log(`Getting state response for state id [${stateId}]`);
    }
    const { body, headers } = await requestPromise;
    this.progress?.show('State downloading', { body, headers });
    const forkName = headers['eth-consensus-version'] as keyof typeof ForkName;
    const bodyBytes = new Uint8Array(await body.arrayBuffer());
    return { bodyBytes, forkName };
  }

  public stateToView(
    bodyBytes: Uint8Array,
    forkName: keyof typeof ForkName,
  ): ContainerTreeViewType<typeof anySsz.BeaconState.fields> {
    return ssz[forkName].BeaconState.deserializeToView(bodyBytes) as ContainerTreeViewType<
      typeof anySsz.BeaconState.fields
    >;
  }

  public blockToView(
    body: BlockInfoResponse,
    forkName: keyof typeof ForkName,
  ): ContainerTreeViewType<typeof anySsz.BeaconBlock.fields> {
    return ssz[forkName].BeaconBlock.toView(
      ssz[forkName].BeaconBlock.fromJson(body.message) as any,
    ) as ContainerTreeViewType<typeof anySsz.BeaconBlock.fields>;
  }
}
