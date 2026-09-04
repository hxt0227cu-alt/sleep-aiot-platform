import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { MetricsService } from './metrics.service';

@Controller()
export class ObservabilityController {
  constructor(
    private readonly health: HealthService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  liveness() {
    return this.health.liveness();
  }

  @Get('health/ready')
  async readiness() {
    const result = await this.health.readiness();
    if (result.status !== 'ready') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  @Get('metrics')
  @HttpCode(HttpStatus.OK)
  async prometheus(@Res() response: Response) {
    response.setHeader('content-type', this.metrics.contentType());
    response.send(await this.metrics.render());
  }
}
