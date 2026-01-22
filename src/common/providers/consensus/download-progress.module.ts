import { Module } from '@nestjs/common';

import { DownloadProgress } from './download-progress';

@Module({
  providers: [DownloadProgress],
  exports: [DownloadProgress],
})
export class DownloadProgressModule {}
