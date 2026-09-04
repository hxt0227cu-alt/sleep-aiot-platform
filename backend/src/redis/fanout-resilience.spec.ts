import { Logger } from '@nestjs/common';
import type { InfraMetricsSink, PubSubBroker } from './contracts';
import { LeaderLockService } from './leader-lock.service';
import { RealtimeFanoutService } from './realtime-fanout.service';

/**
 * 回归测试（ADR-019）。
 *
 * 背景：WebSocketService 有 10 处 `this.fanout.publishToX(...)` 调用既不 await
 * 也不 catch。在修复前，Redis 抖动会让 publish 的 rejection 变成 unhandled
 * rejection —— Node 15+ 默认因此终止进程，三个副本会同时 crash-loop。
 * 即"尽力而为的推送失败"被放大成"全站不可用"。
 *
 * 这里锁定修复后的语义：发布失败是**被计数的正常事件**，不是异常。
 */

const buildSink = (): jest.Mocked<InfraMetricsSink> => ({
  fanoutPublished: jest.fn(),
  fanoutPublishFailed: jest.fn(),
  fanoutReceived: jest.fn(),
  leaderLockOutcome: jest.fn(),
});

describe('RealtimeFanoutService 发布失败时的韧性', () => {
  let sink: jest.Mocked<InfraMetricsSink>;
  let failingBroker: PubSubBroker;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    sink = buildSink();
    failingBroker = {
      publish: jest.fn().mockRejectedValue(new Error('redis unreachable')),
      subscribe: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'device',
      (s: RealtimeFanoutService) =>
        s.publishToDevice('d1', { type: 't', data: {} }),
    ],
    [
      'user',
      (s: RealtimeFanoutService) =>
        s.publishToUser('u1', { type: 't', data: {} }),
    ],
    [
      'all',
      (s: RealtimeFanoutService) => s.publishToAll({ type: 't', data: {} }),
    ],
  ])(
    'publishTo%s 在 broker 故障时 resolve 而非 reject（否则 fire-and-forget 调用点会拖垮进程）',
    async (kind, invoke) => {
      const fanout = new RealtimeFanoutService(failingBroker, sink);

      await expect(invoke(fanout)).resolves.toBeUndefined();
      expect(sink.fanoutPublishFailed).toHaveBeenCalledWith(kind);
      expect(sink.fanoutPublished).not.toHaveBeenCalled();
    },
  );

  it('模拟生产调用方式：不 await 也不产生未处理的 rejection', async () => {
    const fanout = new RealtimeFanoutService(failingBroker, sink);
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);

    // 与 WebSocketService 中的调用方式完全一致：fire-and-forget。
    fanout.publishToDevice('d1', { type: 'vital_signs', data: {} });

    // 让微任务队列排空，未处理的 rejection 会在此期间被上报。
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  it('发布成功时只计成功数', async () => {
    const okBroker: PubSubBroker = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
    };
    const fanout = new RealtimeFanoutService(okBroker, sink);

    await fanout.publishToDevice('d1', { type: 't', data: {} });

    expect(sink.fanoutPublished).toHaveBeenCalledWith('device');
    expect(sink.fanoutPublishFailed).not.toHaveBeenCalled();
  });

  it('缺少 metrics sink 时（既有单测的构造方式）依然正常工作', async () => {
    const fanout = new RealtimeFanoutService(failingBroker);

    await expect(
      fanout.publishToDevice('d1', { type: 't', data: {} }),
    ).resolves.toBeUndefined();
  });

  it('收到扇出消息时按 kind 计数', async () => {
    let captured: ((channel: string, raw: string) => void) | undefined;
    const broker: PubSubBroker = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest
        .fn()
        .mockImplementation(
          (_pattern: string, handler: (c: string, raw: string) => void) => {
            captured = handler;
            return Promise.resolve();
          },
        ),
    };
    const fanout = new RealtimeFanoutService(broker, sink);
    const delivered: unknown[] = [];

    await fanout.subscribe((env) => delivered.push(env));
    captured?.(
      'rt:device:d1',
      JSON.stringify({ kind: 'device', target: 'd1', type: 't', data: {} }),
    );

    expect(sink.fanoutReceived).toHaveBeenCalledWith('device');
    expect(delivered).toHaveLength(1);
  });
});

describe('LeaderLockService 抢锁结果计数', () => {
  let sink: jest.Mocked<InfraMetricsSink>;

  beforeEach(() => {
    sink = buildSink();
  });

  it('抢到锁并执行成功时记 acquired', async () => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LeaderLockService(lock, sink);

    await expect(service.runIfLeader('sweep', 1000, () => {})).resolves.toBe(
      true,
    );
    expect(sink.leaderLockOutcome).toHaveBeenCalledWith('sweep', 'acquired');
  });

  it('被其他副本抢占时记 skipped（这是正常态，不应告警）', async () => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(false),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LeaderLockService(lock, sink);

    await expect(service.runIfLeader('sweep', 1000, () => {})).resolves.toBe(
      false,
    );
    expect(sink.leaderLockOutcome).toHaveBeenCalledWith('sweep', 'skipped');
  });

  it('job 抛错时记 failed，并保持异常向上传播与锁释放', async () => {
    const lock = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LeaderLockService(lock, sink);

    await expect(
      service.runIfLeader('sweep', 1000, () =>
        Promise.reject(new Error('job blew up')),
      ),
    ).rejects.toThrow('job blew up');

    expect(sink.leaderLockOutcome).toHaveBeenCalledWith('sweep', 'failed');
    expect(lock.release).toHaveBeenCalled();
  });
});
