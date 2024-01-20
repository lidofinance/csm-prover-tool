import { Module } from '@nestjs/common';

import { HandlersService } from './handlers.service';

@Module({
  providers: [HandlersService],
})
export class HandlersModule {}
