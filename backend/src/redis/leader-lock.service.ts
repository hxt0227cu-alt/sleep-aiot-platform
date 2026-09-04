import { Injectable, Optional } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { DISTRIBUTED_LOCK, INFRA_METRICS_SINK } from './contracts';
import type { DistributedLock, InfraMetricsSink } from './contracts';

/**
 * 认领式定时任务协调（ADR-015）。
 *
 * 把"每个副本都以 setInterval 跑同一段周期逻辑"收敛为"集群内同一时刻至多一个
 * 副本在执行"。适用于周期性扫表/写库的定时器（如设备在线状态巡检），避免 N 副本
 * 各自重复执行带来的重复写库与读放大。
 *
 * 语义：在 ttlMs 窗口内，runIfLeader 对同一个 lockKey 只有一个调用方返回 true 并执行
 * job；其余副本在同一窗口内返回 false 并跳过。这是悲观互斥，简单、可逆，且复用了
 * 仓库已有的 Redis 基础设施。对于已经用数据库乐观认领（updateMany status / outbox
 * claimBatch）的定时器，无需使用本服务——它们本身就是正确的范式。
 */
@Injectable()
export class LeaderLockService {
  constructor(
    @Inject(DISTRIBUTED_LOCK) private readonly lock: DistributedLock,
    @Optional()
    @Inject(INFRA_METRICS_SINK)
    private readonly metrics?: InfraMetricsSink,
  ) {}

  /**
   * @returns true 表示本副本获得执行权并已执行 job；false 表示被其他副本抢占，已跳过。
   *
   * 指标语义（ADR-019）：skipped 是正常态（N-1 个副本每轮都会 skip），
   * 真正的故障信号是"有 attempts 但长期没有 acquired"——说明锁拿不到，
   * 定时任务在无任何报错的情况下整体停摆。对应告警 BackendApiLeaderLockStarved。
   */
  async runIfLeader(
    lockKey: string,
    ttlMs: number,
    job: () => Promise<void> | void,
  ): Promise<boolean> {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const acquired = await this.lock.acquire(lockKey, token, ttlMs);
    if (!acquired) {
      this.metrics?.leaderLockOutcome(lockKey, 'skipped');
      return false;
    }
    try {
      await job();
      this.metrics?.leaderLockOutcome(lockKey, 'acquired');
      return true;
    } catch (error) {
      this.metrics?.leaderLockOutcome(lockKey, 'failed');
      throw error;
    } finally {
      await this.lock.release(lockKey, token).catch(() => {
        /* 释放失败（如已自然过期）可忽略 */
      });
    }
  }
}
