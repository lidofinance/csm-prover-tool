import { Module } from '@nestjs/common';

import { WorkersService } from './workers.service';

@Module({
  imports: [],
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
