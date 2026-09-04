import { Logger } from '@nestjs/common';
import { PrometheusInfraMetricsSink } from './infra-metrics.sink';
import { MetricsService } from './metrics.service';

describe('PrometheusInfraMetricsSink', () => {
  let metrics: MetricsService;
  let sink: PrometheusInfraMetricsSink;

  beforeEach(() => {
    // 不调用 onModuleInit：避免注册默认进程指标，让断言只针对业务指标。
    metrics = new MetricsService();
    sink = new PrometheusInfraMetricsSink(metrics);
  });

  it('按 kind 统计扇出发布成功数', async () => {
    sink.fanoutPublished('device');
    sink.fanoutPublished('device');
    sink.fanoutPublished('user');

    const output = await metrics.registry.metrics();

    expect(output).toContain('sleep_fanout_published_total{kind="device"} 2');
    expect(output).toContain('sleep_fanout_published_total{kind="user"} 1');
  });

  it('单独统计发布失败数（静默投递丢失的唯一信号）', async () => {
    sink.fanoutPublishFailed('all');

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'sleep_fanout_publish_failures_total{kind="all"} 1',
    );
  });

  it('统计本副本收到的扇出消息数', async () => {
    sink.fanoutReceived('device');

    const output = await metrics.registry.metrics();

    expect(output).toContain('sleep_fanout_received_total{kind="device"} 1');
  });

  it('按锁键与结果统计抢锁，使"有尝试但无人获得"可被告警识别', async () => {
    sink.leaderLockOutcome('device:online-sweep', 'skipped');
    sink.leaderLockOutcome('device:online-sweep', 'skipped');
    sink.leaderLockOutcome('device:online-sweep', 'acquired');
    sink.leaderLockOutcome('device:online-sweep', 'failed');

    const output = await metrics.registry.metrics();

    expect(output).toContain(
      'sleep_leader_lock_runs_total{lock_key="device:online-sweep",outcome="skipped"} 2',
    );
    expect(output).toContain(
      'sleep_leader_lock_runs_total{lock_key="device:online-sweep",outcome="acquired"} 1',
    );
    expect(output).toContain(
      'sleep_leader_lock_runs_total{lock_key="device:online-sweep",outcome="failed"} 1',
    );
  });

  it('指标记录失败绝不能把异常抛回业务路径', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const brokenMetrics = {
      fanoutPublished: {
        inc: () => {
          throw new Error('label cardinality exploded');
        },
      },
    } as unknown as MetricsService;
    const brokenSink = new PrometheusInfraMetricsSink(brokenMetrics);

    expect(() => brokenSink.fanoutPublished('device')).not.toThrow();
  });
});
