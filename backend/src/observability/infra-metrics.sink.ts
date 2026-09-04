import { Injectable, Logger } from '@nestjs/common';
import type { InfraMetricsSink } from '../redis/contracts';
import { MetricsService } from './metrics.service';

/**
 * InfraMetricsSink 的 Prometheus 适配器（ADR-019）。
 *
 * 依赖方向：redis 模块定义端口，observability 模块提供实现。
 * 这样横向扩展基础设施（扇出、抢锁）不需要知道监控技术选型，
 * 换掉 Prometheus 只影响本文件。
 *
 * 硬性约束：所有方法都不得抛异常。指标记录发生在业务路径上，
 * 一次 label 校验失败不能把一条实时消息或一次定时任务搞挂。
 */
@Injectable()
export class PrometheusInfraMetricsSink implements InfraMetricsSink {
  private readonly logger = new Logger(PrometheusInfraMetricsSink.name);

  constructor(private readonly metrics: MetricsService) {}

  fanoutPublished(kind: string): void {
    this.safely(() => this.metrics.fanoutPublished.inc({ kind }));
  }

  fanoutPublishFailed(kind: string): void {
    this.safely(() => this.metrics.fanoutPublishFailures.inc({ kind }));
  }

  fanoutReceived(kind: string): void {
    this.safely(() => this.metrics.fanoutReceived.inc({ kind }));
  }

  leaderLockOutcome(
    lockKey: string,
    outcome: 'acquired' | 'skipped' | 'failed',
  ): void {
    // lock_key 基数受控：锁键来自代码中的常量，不含用户输入。
    this.safely(() =>
      this.metrics.leaderLockRuns.inc({ lock_key: lockKey, outcome }),
    );
  }

  private safely(record: () => void): void {
    try {
      record();
    } catch (error) {
      this.logger.warn(
        `Failed to record infra metric: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
