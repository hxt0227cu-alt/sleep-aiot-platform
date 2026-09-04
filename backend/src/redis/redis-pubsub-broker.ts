import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PubSubBroker } from './contracts';
import { RedisService } from './redis.service';

/**
 * 基于 Redis 的 Pub/Sub 总线实现。
 *
 * 关键约束：ioredis 的连接一旦进入订阅模式就不能再执行普通命令，
 * 因此 subscriber 必须是独立于主连接的专用连接（通过主连接的 duplicate() 获得）。
 * publish 走主连接，subscribe 走 subscriber 连接，二者互不干扰。
 *
 * 模式订阅（psubscribe）让任一副本发布的消息都被所有副本的 subscriber 收到，
 * 从而实现"任一副本发布、所有副本本地投递"的跨副本扇出（见 ADR-014）。
 */
@Injectable()
export class RedisPubSubBroker implements PubSubBroker, OnModuleDestroy {
  private readonly subscriber;
  private readonly handlers = new Map<
    string,
    (channel: string, message: string) => void
  >();

  constructor(private readonly redisService: RedisService) {
    this.subscriber = this.redisService.duplicate();
    this.subscriber.on(
      'pmessage',
      (pattern: string, channel: string, message: string) => {
        const handler = this.handlers.get(pattern);
        if (handler) {
          handler(channel, message);
        }
      },
    );
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.redisService.getClient().publish(channel, message);
  }

  async subscribe(
    pattern: string,
    handler: (channel: string, message: string) => void,
  ): Promise<void> {
    if (this.handlers.has(pattern)) {
      return;
    }
    this.handlers.set(pattern, handler);
    await this.subscriber.psubscribe(pattern);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.subscriber.quit();
    } catch {
      // 进程关闭时忽略断开错误
    }
  }
}
