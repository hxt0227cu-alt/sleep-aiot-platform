import {
  RealtimeFanoutService,
  resolveLocalBroadcast,
  FanoutEnvelope,
} from './realtime-fanout.service';
import { PubSubBroker } from './contracts';

/**
 * 内存版 Pub/Sub broker：模拟 Redis 被多个副本共享的总线。
 * 任一副本 publish，所有副本的 subscriber 都会收到 —— 这正是跨副本扇出的前提。
 */
class InMemoryBroker implements PubSubBroker {
  private subs = new Map<string, (channel: string, message: string) => void>();

  publish(channel: string, message: string): Promise<void> {
    for (const [pattern, handler] of this.subs) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(channel)) {
        handler(channel, message);
      }
    }
    return Promise.resolve();
  }

  subscribe(
    pattern: string,
    handler: (channel: string, message: string) => void,
  ): Promise<void> {
    this.subs.set(pattern, handler);
    return Promise.resolve();
  }
}

/** 模拟网关的本地投递能力 */
class FakeGateway {
  device = jest.fn();
  user = jest.fn();
  all = jest.fn();
}

describe('RealtimeFanoutService（ADR-014 跨副本扇出）', () => {
  it('副本 A 发布的设备消息，能被副本 B 的本地投递收到（跨副本不丢投）', async () => {
    const broker = new InMemoryBroker();
    const replicaA = new RealtimeFanoutService(broker);
    const replicaB = new RealtimeFanoutService(broker);

    // 副本 B 订阅并把信封映射到本地投递（与 websocket.gateway.dispatchFanout 同构）
    const gatewayB = new FakeGateway();
    await replicaB.subscribe((env: FanoutEnvelope) => {
      const b = resolveLocalBroadcast(env);
      if (!b) return;
      if (b.method === 'device') gatewayB.device(b.target, b.message);
      if (b.method === 'user') gatewayB.user(b.target, b.message);
      if (b.method === 'all') gatewayB.all(b.message);
    });

    // 客户端连在副本 B 上。副本 A 收到业务事件后发布。
    await replicaA.publishToDevice('dev-1', {
      type: 'vital_signs',
      data: { hr: 72 },
    });

    expect(gatewayB.device).toHaveBeenCalledTimes(1);
    expect(gatewayB.device).toHaveBeenCalledWith('dev-1', {
      type: 'vital_signs',
      data: { hr: 72 },
    });
  });

  it('不同 target 的频道互相隔离（设备消息不会误投到其他设备）', async () => {
    const broker = new InMemoryBroker();
    const replicaA = new RealtimeFanoutService(broker);
    const replicaB = new RealtimeFanoutService(broker);

    const gatewayB = new FakeGateway();
    await replicaB.subscribe((env) => {
      const b = resolveLocalBroadcast(env);
      if (b?.method === 'device') gatewayB.device(b.target, b.message);
    });

    await replicaA.publishToDevice('dev-1', { type: 'x', data: 1 });
    await replicaA.publishToDevice('dev-2', { type: 'x', data: 2 });

    expect(gatewayB.device).toHaveBeenCalledTimes(2);
    expect(gatewayB.device).toHaveBeenNthCalledWith(1, 'dev-1', {
      type: 'x',
      data: 1,
    });
    expect(gatewayB.device).toHaveBeenNthCalledWith(2, 'dev-2', {
      type: 'x',
      data: 2,
    });
  });

  it('user 与 all 频道分别路由正确', async () => {
    const broker = new InMemoryBroker();
    const replicaA = new RealtimeFanoutService(broker);
    const replicaB = new RealtimeFanoutService(broker);

    const gatewayB = new FakeGateway();
    await replicaB.subscribe((env) => {
      const b = resolveLocalBroadcast(env);
      if (!b) return;
      if (b.method === 'user') gatewayB.user(b.target, b.message);
      if (b.method === 'all') gatewayB.all(b.message);
    });

    await replicaA.publishToUser('u-1', {
      type: 'notification',
      data: { foo: 1 },
    });
    await replicaA.publishToAll({ type: 'system', data: { bar: 2 } });

    expect(gatewayB.user).toHaveBeenCalledWith('u-1', {
      type: 'notification',
      data: { foo: 1 },
    });
    expect(gatewayB.all).toHaveBeenCalledWith({
      type: 'system',
      data: { bar: 2 },
    });
  });
});

describe('resolveLocalBroadcast（信封→本地投递映射，纯函数）', () => {
  it('device / user / all 映射正确', () => {
    expect(
      resolveLocalBroadcast({
        kind: 'device',
        target: 'd',
        type: 't',
        data: 1,
      }),
    ).toEqual({
      method: 'device',
      target: 'd',
      message: { type: 't', data: 1 },
    });
    expect(
      resolveLocalBroadcast({ kind: 'user', target: 'u', type: 't', data: 1 }),
    ).toEqual({
      method: 'user',
      target: 'u',
      message: { type: 't', data: 1 },
    });
    expect(resolveLocalBroadcast({ kind: 'all', type: 't', data: 1 })).toEqual({
      method: 'all',
      message: { type: 't', data: 1 },
    });
  });

  it('缺 type 返回 null（避免非法信封被投递）', () => {
    expect(
      resolveLocalBroadcast({ kind: 'device', target: 'd' } as any),
    ).toBeNull();
  });
});
