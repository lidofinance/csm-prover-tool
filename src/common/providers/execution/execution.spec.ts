import { Test, TestingModule } from '@nestjs/testing';

import { Execution } from './execution';

describe('Execution', () => {
  let provider: Execution;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Execution],
    }).compile();

    provider = module.get<Execution>(Execution);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
