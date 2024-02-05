import { Test, TestingModule } from '@nestjs/testing';

import { DownloadProgress } from './download-progress';

describe('DownloadProgress', () => {
  let provider: DownloadProgress;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DownloadProgress],
    }).compile();

    provider = module.get<DownloadProgress>(DownloadProgress);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
