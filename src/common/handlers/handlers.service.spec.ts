import { Test, TestingModule } from '@nestjs/testing';

import { HandlersService } from './handlers.service';

describe('HandlersService', () => {
  let service: HandlersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HandlersService],
    }).compile();

    service = module.get<HandlersService>(HandlersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
