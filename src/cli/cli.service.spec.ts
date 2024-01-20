import { Test, TestingModule } from '@nestjs/testing';

import { CliService } from './cli.service';
import { LoggerModule } from '../common/logger/logger.module';

describe('CliService', () => {
  let service: CliService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [LoggerModule],
      providers: [CliService],
    }).compile();

    service = module.get<CliService>(CliService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
