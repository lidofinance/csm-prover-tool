import { Test, TestingModule } from '@nestjs/testing';

import { DaemonService } from './daemon.service';
import { LoggerModule } from '../common/logger/logger.module';

describe('DaemonService', () => {
  let service: DaemonService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [LoggerModule],
      providers: [DaemonService],
    }).compile();

    service = module.get<DaemonService>(DaemonService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
