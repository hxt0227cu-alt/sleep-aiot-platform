import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MqttService } from '../mqtt/mqtt.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from './metrics.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mqtt: MqttService,
    private readonly metrics: MetricsService,
  ) {}

  liveness() {
    return {
      status: 'ok',
      service: 'backend-api',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async readiness() {
    const checks = {
      postgres: await this.check(async () => {
        await this.prisma.$queryRawUnsafe('SELECT 1');
      }),
      redis: await this.check(async () => {
        const result = await this.redis.getClient().ping();
        if (result !== 'PONG') {
          throw new Error('Redis ping did not return PONG');
        }
      }),
      mqtt: this.mqtt.isConnected()
        ? { ready: true, latencyMs: 0 }
        : { ready: false, latencyMs: 0, error: 'MQTT is disconnected' },
    };

    for (const [dependency, result] of Object.entries(checks)) {
      this.metrics.dependencyHealth.set({ dependency }, result.ready ? 1 : 0);
    }

    return {
      status: Object.values(checks).every((result) => result.ready)
        ? 'ready'
        : 'not_ready',
      checks,
    };
  }

  private async check(operation: () => Promise<void>) {
    const startedAt = performance.now();
    try {
      await operation();
      return {
        ready: true,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    } catch (error) {
      return {
        ready: false,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
