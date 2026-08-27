import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller.js';
import { ReadinessService } from './readiness.service.js';
import { ReadyController } from './ready.controller.js';

@Module({
  providers: [ReadinessService],
  controllers: [HealthController, ReadyController],
  imports: [TerminusModule],
  exports: [ReadinessService],
})
export class HealthModule {}
