import { Module } from '@nestjs/common';

import { HandlersService } from './handlers.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  providers: [HandlersService],
  exports: [HandlersService],
})
export class HandlersModule {}
