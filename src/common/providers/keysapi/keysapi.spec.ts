import { Test, TestingModule } from '@nestjs/testing';
import { Keysapi } from './keysapi';

describe('Keysapi', () => {
  let provider: Keysapi;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Keysapi],
    }).compile();

    provider = module.get<Keysapi>(Keysapi);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
