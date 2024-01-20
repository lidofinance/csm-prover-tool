import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { DaemonModule } from '../src/daemon/daemon.module';

describe('Daemon (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [DaemonModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('does nothing', () => {
    return;
  });
});
