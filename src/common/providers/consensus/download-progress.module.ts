import { Module } from '@nestjs/common';

import { DownloadProgress } from './download-progress.js';

@Module({
  providers: [DownloadProgress],
  exports: [DownloadProgress],
})
export class DownloadProgressModule {}
