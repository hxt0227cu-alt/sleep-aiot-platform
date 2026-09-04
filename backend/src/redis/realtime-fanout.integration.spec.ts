import {
  RealtimeFanoutService,
  FanoutEnvelope,
} from './realtime-fanout.service';
import { RedisPubSubBroker } from './redis-pubsub-broker';
import { RedisService } from './redis.service';

/**
 * 跨副本扇出的"真实"验证（ADR-014）。
 *
 * 之前的 realtime-fanout.spec.ts 用的是内存假 broker，只能证明设计意图。
 * 本集成测试在 REDIS_URL 可用时，用两个各自持有独立 Redis 连接的
 * RealtimeFanoutService 实例（模拟两个 backend 副本），让副本 A 发布、
 * 断言副本 B 的订阅 handler 真实收到——即"任一副本发布、所有副本本地投递"
 * 的跨副本扇出在真实 Redis Pub/Sub 上成立。
 *
 * 当环境变量 REDIS_URL 缺失时整体跳过（本地无 Redis 不报红），
 * 由 CI 的 Redis service container 提供真实实例来真正执行。
 */

const REDIS_URL = process.env.REDIS_URL;
const describeOrSkip = REDIS_URL ? describe : describe.skip;

function makeFanout(url: string): {
  fanout: RealtimeFanoutService;
  redis: RedisService;
  broker: RedisPubSubBroker;
} {
  const redis = new RedisService({
    get: (k: string) => (k === 'REDIS_URL' ? url : undefined),
  } as any);
  const broker = new RedisPubSubBroker(redis);
  const fanout = new RealtimeFanoutService(broker);
  return { fanout, redis, broker };
}

describeOrSkip('跨副本实时扇出（真实 Redis Pub/Sub）', () => {
  let replicaA: ReturnType<typeof makeFanout>;
  let replicaB: ReturnType<typeof makeFanout>;

  beforeAll(() => {
    replicaA = makeFanout(REDIS_URL!);
    replicaB = makeFanout(REDIS_URL!);
  });

  afterAll(async () => {
    await replicaB.broker.onModuleDestroy().catch(() => {});
    await replicaA.broker.onModuleDestroy().catch(() => {});
    await replicaB.redis.onModuleDestroy().catch(() => {});
    await replicaA.redis.onModuleDestroy().catch(() => {});
  });

  it('副本 A 发布的设备消息被副本 B 真实收到', async () => {
    const received = new Promise<FanoutEnvelope>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('副本 B 在超时内未收到跨副本消息')),
        4000,
      );
      replicaB.fanout
        .subscribe((env) => {
          if (env?.kind === 'device' && env.target === 'dev-x1') {
            clearTimeout(timer);
            resolve(env);
          }
        })
        .catch(reject);
    });

    // 等待副本 B 的 psubscribe 在真实 Redis 上就绪，避免发布早于订阅
    await new Promise((r) => setTimeout(r, 300));

    await replicaA.fanout.publishToDevice('dev-x1', {
      type: 'sleep/update',
      data: { hr: 62, spo2: 97 },
    });

    const env = await received;
    expect(env.kind).toBe('device');
    expect(env.target).toBe('dev-x1');
    expect(env.type).toBe('sleep/update');
    expect(env.data).toEqual({ hr: 62, spo2: 97 });
  });
});
