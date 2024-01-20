import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { CliModule } from '../src/cli/cli.module';

describe('Cli (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CliModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('does nothing', () => {
    return;
  });
});
