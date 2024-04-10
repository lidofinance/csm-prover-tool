import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CommandTestFactory } from 'nest-commander-testing';

import { CliModule } from '../src/cli/cli.module';
import { ConfigService } from '../src/common/config/config.service';
import { EnvironmentVariables } from '../src/common/config/env.validation';

class CustomConfigService extends ConfigService {
  public get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    if (key == 'WORKING_MODE') {
      return 'cli' as EnvironmentVariables[T];
    }
    return super.get(key) as EnvironmentVariables[T];
  }
}

describe('Cli (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await CommandTestFactory.createTestingCommand({
      imports: [CliModule],
    })
      .overrideProvider(ConfigService)
      .useClass(CustomConfigService)
      .compile();
  });

  it('does nothing', () => {
    return;
  });
});
