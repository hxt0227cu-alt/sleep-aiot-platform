import { Module, Global } from '@nestjs/common';
import { TenantRateLimiterService } from './tenant-rate-limiter.service';
import { UserRateLimiterService } from './user-rate-limiter.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { RedisModule } from '../redis/redis.module';

/**
 * 限流熔断模块
 *
 * 提供租户级限流、用户级限流和第三方依赖熔断能力。
 *
 * 全局模块，所有业务模块均可直接注入使用。
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [TenantRateLimiterService, UserRateLimiterService, CircuitBreakerService],
  exports: [TenantRateLimiterService, UserRateLimiterService, CircuitBreakerService],
})
export class RateLimitModule {}
