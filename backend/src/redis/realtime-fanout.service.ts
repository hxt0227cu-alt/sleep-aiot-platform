import { Injectable, Logger, Optional } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { INFRA_METRICS_SINK, PUB_SUB_BROKER } from './contracts';
import type { InfraMetricsSink, PubSubBroker } from './contracts';

/**
 * 跨副本实时消息扇出服务（ADR-014）。
 *
 * 设计要点：
 * - 网关进程内的 clients / userClients / deviceClients 仍按副本本地持有
 *   （它们只记录"本副本终结的连接"，这是合法且有意的，见 ADR-012）。
 * - 但一条实时消息需要投递给"连接在任何副本上的目标"。做法：发布方把消息
 *   发到 Redis 频道，所有副本的 subscriber 收到后，各自只投递给"自己本地"
 *   持有的连接。由于一个客户端只连一个副本，因此每个目标恰好收到一次，
 *   且无需客户端协议改动（保留裸 ws）。
 *
 * 投放语义：at-most-once。Redis Pub/Sub 不持久化，副本订阅就绪前的瞬时消息会丢失。
 * 因此推送载荷必须是"可重算的快照"而非"依赖顺序的增量"——上层 WebSocketService
 * 发送的全部是快照，符合此约束。
 */

export type FanoutTarget = 'device' | 'user' | 'all';

/**
 * 扇出载荷。
 *
 * `data` 用 `unknown` 而非 `any`：本服务只负责 JSON 透传，从不读取其内部结构。
 * 用 `unknown` 可以在编译期阻止"顺手在扇出层解读业务字段"这种越界耦合，
 * 同时不影响任何调用方（写入端可赋任意值）。
 */
export interface FanoutEnvelope {
  kind: FanoutTarget;
  /** deviceId 或 userId；kind==='all' 时可为空 */
  target?: string;
  type: string;
  data: unknown;
}

export interface LocalBroadcast {
  method: FanoutTarget;
  target?: string;
  message: { type: string; data: unknown };
}

/** 把扇出信封映射为网关注册的本地投递调用。纯函数，便于单测。 */
export function resolveLocalBroadcast(
  env: FanoutEnvelope,
): LocalBroadcast | null {
  if (!env || typeof env.type !== 'string') {
    return null;
  }
  const message = { type: env.type, data: env.data };
  switch (env.kind) {
    case 'device':
      return { method: 'device', target: env.target, message };
    case 'user':
      return { method: 'user', target: env.target, message };
    case 'all':
      return { method: 'all', message };
    default:
      return null;
  }
}

@Injectable()
export class RealtimeFanoutService {
  private readonly logger = new Logger(RealtimeFanoutService.name);
  private subscribed = false;

  constructor(
    @Inject(PUB_SUB_BROKER) private readonly broker: PubSubBroker,
    @Optional()
    @Inject(INFRA_METRICS_SINK)
    private readonly metrics?: InfraMetricsSink,
  ) {}

  /**
   * 统一的发布路径：**失败不外抛**（ADR-019）。
   *
   * 取舍说明：上层 WebSocketService 的 10 处调用点都是 fire-and-forget
   * （既不 await 也不 catch）。若这里让异常冒泡，Redis 短暂抖动就会产生
   * unhandled rejection —— Node 15+ 默认会因此终止进程，三个副本会同时
   * crash-loop。也就是说，一个"尽力而为的推送"故障会升级成全站不可用。
   *
   * 本服务的投放语义本就是 at-most-once（见文件头），丢一条消息在契约之内，
   * 崩掉进程不在。因此改为：吞掉异常 + 计数 + 记日志，由
   * sleep_fanout_publish_failures_total 告警暴露。
   *
   * 放弃了什么：调用方无法感知单次发布失败。当前没有任何调用方需要感知；
   * 若将来出现需要"确保送达"的场景，应改用持久化队列（outbox），而不是
   * 让 Pub/Sub 抛错。
   */
  private async publish(
    kind: FanoutTarget,
    channel: string,
    payload: string,
  ): Promise<void> {
    try {
      await this.broker.publish(channel, payload);
      this.metrics?.fanoutPublished(kind);
    } catch (error) {
      this.metrics?.fanoutPublishFailed(kind);
      this.logger.error(
        `Fanout publish failed on channel ${channel}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async publishToDevice(
    deviceId: string,
    message: { type: string; data: unknown },
  ): Promise<void> {
    await this.publish(
      'device',
      `rt:device:${deviceId}`,
      JSON.stringify({ kind: 'device', target: deviceId, ...message }),
    );
  }

  async publishToUser(
    userId: string,
    message: { type: string; data: unknown },
  ): Promise<void> {
    await this.publish(
      'user',
      `rt:user:${userId}`,
      JSON.stringify({ kind: 'user', target: userId, ...message }),
    );
  }

  async publishToAll(message: { type: string; data: unknown }): Promise<void> {
    await this.publish(
      'all',
      'rt:all',
      JSON.stringify({ kind: 'all', ...message }),
    );
  }

  /**
   * 注册跨副本订阅。任一副本发布后，本副本的 handler 会收到解码后的信封。
   * 幂等：单例服务下只订阅一次。
   */
  async subscribe(handler: (env: FanoutEnvelope) => void): Promise<void> {
    if (this.subscribed) {
      return;
    }
    this.subscribed = true;
    await this.broker.subscribe('rt:*', (_channel: string, raw: string) => {
      try {
        const env = JSON.parse(raw) as FanoutEnvelope;
        this.metrics?.fanoutReceived(env?.kind ?? 'unknown');
        handler(env);
      } catch (error) {
        this.logger.error('Failed to parse fanout message', error);
      }
    });
  }
}
