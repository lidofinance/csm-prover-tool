import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { ContractsInitializer } from '../src/common/contracts/contracts-initializer.service.js';
import { Consensus } from '../src/common/providers/consensus/consensus.js';
import { DaemonModule } from '../src/daemon/daemon.module.js';

describe('Daemon (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DaemonModule],
    })
      .overrideProvider(Consensus)
      .useValue({
        onModuleInit: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(ContractsInitializer)
      .useValue({
        onModuleInit: jest.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('does nothing', () => {
    return;
  });
});
