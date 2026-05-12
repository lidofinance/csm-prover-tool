import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import buildInfo from '../build-info.js';
import { KeysIndexer } from './services/keys-indexer.js';
import { RootsProcessor } from './services/roots-processor.js';
import { RootsProvider } from './services/roots-provider.js';
import { SingletonTask } from './utils/singleton-task.decorator.js';
import sleep from './utils/sleep.js';
import { ConfigService } from '../common/config/config.service.js';
import { SECOND_MS } from '../common/config/env.validation.js';
import { type AppLogger } from '../common/logger/app-logger.type.js';
import { APP_NAME, PrometheusService, TrackTask } from '../common/prometheus/index.js';
import { ProverService } from '../common/prover/prover.service.js';
import { Consensus } from '../common/providers/consensus/consensus.js';
import { type BlockHeaderResponse } from '../common/providers/consensus/response.interface.js';

@Injectable()
export class DaemonService implements OnModuleInit {
  private lastFinalizedHeader: BlockHeaderResponse | null = null;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: AppLogger,
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
    const filteredOperatorIds = this.config.get('DAEMON_NODE_OPERATOR_IDS');
    if (filteredOperatorIds?.length) {
      this.logger.warn(`Running for Node Operator IDs: ${filteredOperatorIds.join(', ')}`);
    }
    const env = this.config.get('NODE_ENV');
    const version = buildInfo.version;
    const commit = buildInfo.commit;
    const branch = buildInfo.branch;
    const name = APP_NAME;

    this.prometheus.buildInfo.labels({ env, name, version, commit, branch }).inc();
  }

  public async loop(): Promise<never> {
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

    const isFinalizedChanged = this.isFinalizedHeaderChanged(finalizedHeader);

    if (isFinalizedChanged && this.keysIndexer.isTimeToUpdate(finalizedHeader)) {
      this.updateKeysIndexer(finalizedHeader).catch((e) => this.logger.error(e));
    }

    if (isFinalizedChanged) {
      this.processBadPerformers(finalizedHeader).catch((e) => this.logger.error(e));
    }

    const nextRoot = await this.rootsProvider.getNext(finalizedHeader);
    if (nextRoot) {
      this.processNextRoot(finalizedHeader, nextRoot).catch((e) => this.logger.error(e));
    }

    if (!nextRoot && !isFinalizedChanged) {
      this.logger.log('💤 Wait 12s for the next finalized root');
      await sleep(12 * SECOND_MS);
    }

    this.lastFinalizedHeader = finalizedHeader;
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
  @TrackTask('process-bad-performers')
  private async processBadPerformers(finalizedHeader: BlockHeaderResponse) {
    await this.prover.handleBadPerformers(finalizedHeader, this.keysIndexer.getFullKeyInfoByPubKey);
  }
}
