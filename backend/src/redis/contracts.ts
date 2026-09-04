/**
 * 跨副本协作的可注入契约。
 * 用接口而非具体实现，便于在单测中用内存假实现替换 Redis/ioredis，
 * 从而在无外部依赖的情况下证明横向扩容行为。
 */

/**
 * 分布式锁契约：用于把"每个副本周期性执行"收敛为"集群内至多一个副本执行"。
 * 语义：acquire 在 TTL 窗口内只有一个调用方成功；release 仅持有者能释放。
 */
export interface DistributedLock {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/**
 * 发布/订阅契约：用于跨副本实时消息扇出。
 * 生产实现基于 Redis Pub/Sub（所有副本共享同一 Redis，等价于"副本间总线"）。
 * 订阅使用模式（如 `rt:*`），publish 使用精确频道。
 */
export interface PubSubBroker {
  publish(channel: string, message: string): Promise<void>;
  subscribe(
    pattern: string,
    handler: (channel: string, message: string) => void,
  ): Promise<void>;
}

/**
 * 可观测性出口（ADR-019）。
 *
 * 依赖倒置：redis 模块只依赖这个接口，具体的 Prometheus 实现由
 * observability 模块以适配器形式提供。这样"扇出/抢锁"这类基础设施
 * 不会反向依赖监控实现，单测里也可以整个省略（注入为可选）。
 *
 * 所有方法都必须是**不抛异常**的：指标记录失败绝不能影响业务路径。
 */
/**
 * 成员刻意用「属性 + 箭头类型」而非方法语法：
 * 方法语法的参数是双变的（bivariant），会放过不安全的实现；属性语法在
 * `strictFunctionTypes` 下按逆变严格检查。对这种会被替换实现、被解构传递的
 * 出口契约来说，严格检查更有价值。
 */
export interface InfraMetricsSink {
  /** 扇出消息成功发布到总线。kind 为 device / user / all。 */
  fanoutPublished: (kind: string) => void;
  /** 扇出消息发布失败——意味着目标客户端静默收不到推送。 */
  fanoutPublishFailed: (kind: string) => void;
  /** 本副本从总线收到一条扇出消息。 */
  fanoutReceived: (kind: string) => void;
  /** 领导者锁抢占结果。 */
  leaderLockOutcome: (
    lockKey: string,
    outcome: 'acquired' | 'skipped' | 'failed',
  ) => void;
}

/** InfraMetricsSink 的注入令牌。 */
export const INFRA_METRICS_SINK = 'InfraMetricsSink';

/** PubSubBroker 的注入令牌。 */
export const PUB_SUB_BROKER = 'PubSubBroker';

/** DistributedLock 的注入令牌。 */
export const DISTRIBUTED_LOCK = 'DistributedLock';
