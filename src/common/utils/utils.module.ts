import { Module } from '@nestjs/common';

import { DownloadProgress } from './download-progress/download-progress';

@Module({
  providers: [DownloadProgress],
  exports: [DownloadProgress],
})
export class UtilsModule {}
