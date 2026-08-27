import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

@Injectable()
export class ReadinessService {
  private ready = false;

  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  // One-way latch: readiness gates rollout, it must not flap on transient dependency errors.
  public markReady(): void {
    this.ready = true;
  }

  public check(): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check('readiness');
    return this.ready ? indicator.up() : indicator.down();
  }
}
