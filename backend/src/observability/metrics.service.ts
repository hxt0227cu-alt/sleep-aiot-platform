import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly httpRequests = new Counter({
    name: 'sleep_http_requests_total',
    help: 'Total HTTP requests handled by the backend',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'sleep_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly activeHttpRequests = new Gauge({
    name: 'sleep_http_active_requests',
    help: 'HTTP requests currently being handled',
    labelNames: ['method'] as const,
    registers: [this.registry],
  });

  readonly dependencyHealth = new Gauge({
    name: 'sleep_dependency_health',
    help: 'Dependency readiness, where 1 is ready and 0 is unavailable',
    labelNames: ['dependency'] as const,
    registers: [this.registry],
  });

  readonly llmRequests = new Counter({
    name: 'sleep_llm_requests_total',
    help: 'LLM requests by operation and outcome',
    labelNames: ['operation', 'model', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly llmDuration = new Histogram({
    name: 'sleep_llm_request_duration_seconds',
    help: 'LLM request duration in seconds',
    labelNames: ['operation', 'model', 'outcome'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90],
    registers: [this.registry],
  });

  // --- 横向扩展基础设施的事件计数（ADR-014 / ADR-015 / ADR-019）---
  //
  // 这些是"事件"而非"状态"，无法在抓取时拉取，必须由领域服务推送。
  // 领域服务通过 @Optional() 注入本服务，因此在缺少 DI 容器的单元测试里
  // 依然可以只用原有构造参数实例化。

  /** 跨副本扇出：本副本发布到 Redis Pub/Sub 的消息数。 */
  readonly fanoutPublished = new Counter({
    name: 'sleep_fanout_published_total',
    help: 'Realtime fanout messages published to Redis Pub/Sub by this replica',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  /**
   * 跨副本扇出：发布失败数。
   * 这是最隐蔽的故障——失败时客户端静默收不到推送，HTTP 错误率毫无反应。
   */
  readonly fanoutPublishFailures = new Counter({
    name: 'sleep_fanout_publish_failures_total',
    help: 'Realtime fanout publish failures (silent delivery loss)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  /** 跨副本扇出：本副本从 Redis 收到并本地投递的消息数。 */
  readonly fanoutReceived = new Counter({
    name: 'sleep_fanout_received_total',
    help: 'Realtime fanout messages received from Redis Pub/Sub by this replica',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  /**
   * 领导者锁：定时任务的抢锁结果。
   * outcome=acquired 表示本副本执行了任务；skipped 表示被其他副本抢占（正常）；
   * failed 表示 job 抛错。全集群长期没有 acquired 即定时任务停摆。
   */
  readonly leaderLockRuns = new Counter({
    name: 'sleep_leader_lock_runs_total',
    help: 'Leader-lock guarded job attempts by lock key and outcome',
    labelNames: ['lock_key', 'outcome'] as const,
    registers: [this.registry],
  });

  onModuleInit() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'sleep_backend_',
    });
  }

  contentType() {
    return this.registry.contentType;
  }

  render() {
    return this.registry.metrics();
  }
}
