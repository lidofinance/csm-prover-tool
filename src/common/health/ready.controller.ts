import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { READY_URL } from './health.constants.js';
import { ReadinessService } from './readiness.service.js';

@Controller(READY_URL)
export class ReadyController {
  constructor(
    private health: HealthCheckService,
    private readiness: ReadinessService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.readiness.check()]);
  }
}
