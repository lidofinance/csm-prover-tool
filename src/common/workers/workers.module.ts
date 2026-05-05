import { Module } from '@nestjs/common';

import { WorkersService } from './workers.service.js';

@Module({
  imports: [],
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
