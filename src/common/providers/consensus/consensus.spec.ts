import { Test, TestingModule } from '@nestjs/testing';

import { Consensus } from './consensus';

describe('Consensus', () => {
  let provider: Consensus;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Consensus],
    }).compile();

    provider = module.get<Consensus>(Consensus);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
