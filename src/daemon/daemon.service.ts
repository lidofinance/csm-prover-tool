import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import * as buildInfo from 'build-info';

import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { SECOND_MS } from '../common/config/env.validation';
import { APP_NAME, PrometheusService, TrackTask } from '../common/prometheus';
import { ProverService } from '../common/prover/prover.service';
import { Consensus } from '../common/providers/consensus/consensus';
import { BlockHeaderResponse } from '../common/providers/consensus/response.interface';
import { SingletonTask } from '../common/utils/singleton-task.decorator';

@Injectable()
export class DaemonService implements OnModuleInit {
  private lastFinalizedHeader: BlockHeaderResponse | null = null;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsProvider: RootsProvider,
    protected readonly rootsProcessor: RootsProcessor,
    protected readonly prover: ProverService,
  ) {}

  async onModuleInit() {
    this.logger.log('Working mode: DAEMON');
    const env = this.config.get('NODE_ENV');
    const version = buildInfo.version;
    const commit = buildInfo.commit;
    const branch = buildInfo.branch;
    const name = APP_NAME;

    this.prometheus.buildInfo.labels({ env, name, version, commit, branch }).inc();
  }

  public async loop() {
    while (true) {
      try {
        if (!this.keysIndexer.isInitialized()) await this.keysIndexer.initOrReadServiceData();
        await this.baseRun();
      } catch (e) {
        this.logger.error(e);
      } finally {
        await sleep(SECOND_MS);
      }
    }
  }

  private async baseRun() {
    const finalizedHeader = await this.consensus.getBeaconHeader('finalized');
    this.logger.log(`💎 Finalized slot [${finalizedHeader.header.message.slot}]. Root [${finalizedHeader.root}]`);

    if (this.isTimeToUpdateKeysIndexer(finalizedHeader)) {
      this.updateKeysIndexer(finalizedHeader).catch((e) => this.logger.error(e));
    }

    if (this.isTimeToProcessCurrentHead(finalizedHeader)) {
      this.processAnyHeadRoot().catch((e) => this.logger.error(e));
    }

    const nextRoot = await this.rootsProvider.getNext(finalizedHeader);
    if (nextRoot) {
      this.processNextRoot(finalizedHeader, nextRoot).catch((e) => this.logger.error(e));
    }

    if (!nextRoot && !this.isFinalizedHeaderChanged(finalizedHeader)) {
      this.logger.log('💤 Wait 12s for the next finalized root');
      await sleep(12 * SECOND_MS);
    }

    this.lastFinalizedHeader = finalizedHeader;
  }

  private isTimeToUpdateKeysIndexer(finalizedHeader: BlockHeaderResponse): boolean {
    return this.isFinalizedHeaderChanged(finalizedHeader) && this.keysIndexer.isTimeToUpdate(finalizedHeader);
  }

  private isTimeToProcessCurrentHead(finalizedHeader: BlockHeaderResponse): boolean {
    return this.isFinalizedHeaderChanged(finalizedHeader);
  }

  private isFinalizedHeaderChanged(finalizedHeader: BlockHeaderResponse): boolean {
    return !this.lastFinalizedHeader || this.lastFinalizedHeader.root !== finalizedHeader.root;
  }

  @SingletonTask()
  @TrackTask('update-keys-indexer')
  private async updateKeysIndexer(finalizedHeader: BlockHeaderResponse) {
    await this.keysIndexer.update(finalizedHeader);
  }

  @SingletonTask()
  @TrackTask('process-next-root')
  private async processNextRoot(finalizedHeader: BlockHeaderResponse, nextRoot: string) {
    await this.rootsProcessor.processNext(nextRoot, finalizedHeader);
  }

  @SingletonTask()
  @TrackTask('process-any-head-root')
  private async processAnyHeadRoot() {
    const headHeader = await this.consensus.getBeaconHeader('head');
    this.logger.log(`🪨 Head slot [${headHeader.header.message.slot}]. Root [${headHeader.root}]`);
    await this.prover.handleBadPerformers(headHeader, this.keysIndexer.getFullKeyInfoByPubKey);
  }
}
