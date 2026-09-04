import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisPubSubBroker } from './redis-pubsub-broker';
import { RealtimeFanoutService } from './realtime-fanout.service';
import { LeaderLockService } from './leader-lock.service';
import { PUB_SUB_BROKER, DISTRIBUTED_LOCK } from './contracts';

/**
 * Redis 基础设施模块（全局）。
 * 提供实时扇出（ADR-014）与分布式锁（ADR-015）所需的服务，
 * 通过接口令牌注入，便于在无 Redis 环境下用内存假实现替换做单测。
 */
@Global()
@Module({
  providers: [
    RedisService,
    RedisPubSubBroker,
    RealtimeFanoutService,
    LeaderLockService,
    { provide: PUB_SUB_BROKER, useClass: RedisPubSubBroker },
    { provide: DISTRIBUTED_LOCK, useExisting: RedisService },
  ],
  exports: [
    RedisService,
    RealtimeFanoutService,
    LeaderLockService,
    PUB_SUB_BROKER,
    DISTRIBUTED_LOCK,
  ],
})
export class RedisModule {}
