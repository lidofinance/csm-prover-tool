import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { Inject, Injectable, LoggerService, OnApplicationBootstrap } from '@nestjs/common';

import { KeysIndexer } from './services/keys-indexer';
import { RootsProcessor } from './services/roots-processor';
import { RootsProvider } from './services/roots-provider';
import sleep from './utils/sleep';
import { ConfigService } from '../common/config/config.service';
import { Consensus } from '../common/providers/consensus/consensus';

@Injectable()
export class DaemonService implements OnApplicationBootstrap {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly config: ConfigService,
    protected readonly consensus: Consensus,
    protected readonly keysIndexer: KeysIndexer,
    protected readonly rootsProvider: RootsProvider,
    protected readonly rootsProcessor: RootsProcessor,
  ) {}

  async onApplicationBootstrap() {
    this.loop().then();
  }

  private async loop() {
    while (true) {
      try {
        await this.baseRun();
      } catch (e) {
        this.logger.error(e);
        await sleep(1000);
      }
    }
  }

  private async baseRun() {
    this.logger.log('🗿 Get finalized header');
    const header = await this.consensus.getBeaconHeader('finalized');
    this.logger.log(`💎 Finalized slot [${header.header.message.slot}]. Root [${header.root}]`);
    await this.keysIndexer.update(header);
    const nextRoot = await this.rootsProvider.getNext(header);
    if (nextRoot) {
      await this.rootsProcessor.process(nextRoot);
    } else {
      this.logger.log(`💤 Wait for the next finalized root`);
      await sleep(12000);
    }
  }
}
