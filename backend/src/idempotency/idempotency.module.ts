import { Module, Global } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { SequenceTrackerService } from './sequence-tracker.service';
import { IdempotencyMiddleware } from './idempotency.middleware';
import { RedisModule } from '../redis/redis.module';

/**
 * 幂等模块
 *
 * 基于 deviceId + localSequence 实现设备数据的幂等写入，
 * 支持乱序、重复数据的自动去重。
 *
 * 全局模块，所有业务模块均可直接注入使用。
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [IdempotencyService, SequenceTrackerService, IdempotencyMiddleware],
  exports: [IdempotencyService, SequenceTrackerService],
})
export class IdempotencyModule {}
