import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnModuleInit } from '@nestjs/common';

import * as buildInfo from 'build-info';

import { KeysIndexer, ModuleNotFoundError } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { CsmContract } from '../common/contracts/csm-contract.service';
import { APP_NAME, PrometheusService } from '../common/prometheus';
import { Consensus } from '../common/providers/consensus/consensus';

@Injectable()
export class DaemonService implements OnModuleInit {
  public CSM_ON_PAUSE_NEXT_TRY_MS = 60000;

  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly prometheus: PrometheusService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsProvider: RootsProvider,
    protected readonly rootsProcessor: RootsProcessor,
    protected readonly csm: CsmContract,
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
        const isOnPause = await this.csm.isPaused();
        if (isOnPause) {
          this.logger.log('🛑 CSModule is paused. Next try in 1 minute');
          await sleep(this.CSM_ON_PAUSE_NEXT_TRY_MS);
          continue;
        }
        if (!this.keysIndexer.isInitialized()) await this.keysIndexer.initOrReadServiceData();
        await this.baseRun();
      } catch (e) {
        this.logger.error(e);
        e instanceof ModuleNotFoundError
          ? await sleep(this.keysIndexer.MODULE_NOT_FOUND_NEXT_TRY_MS)
          : await sleep(1000);
      }
    }
  }

  private async baseRun() {
    this.logger.log('🗿 Get finalized header');
    const header = await this.consensus.getBeaconHeader('finalized');
    this.logger.log(`💎 Finalized slot [${header.header.message.slot}]. Root [${header.root}]`);
    this.keysIndexer.update(header);
    const nextRoot = await this.rootsProvider.getNext(header);
    if (nextRoot) {
      await this.rootsProcessor.process(nextRoot, header);
      return;
    }
    this.logger.log(`💤 Wait for the next finalized root`);
    await sleep(12000);
  }
}
