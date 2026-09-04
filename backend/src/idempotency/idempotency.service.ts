import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 幂等核心服务
 *
 * 基于 deviceId + localSequence 实现设备数据的幂等写入，
 * 支持乱序、重复数据的自动去重。
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /** 幂等键前缀 */
  private readonly IDEMPOTENCY_PREFIX = 'idempotency:event:';

  /** 序列号追踪前缀 */
  private readonly SEQUENCE_PREFIX = 'idempotency:sequence:';

  /** 幂等记录 TTL（秒） */
  private readonly IDEMPOTENCY_TTL = 7 * 24 * 60 * 60; // 7 天

  /** 序列号回绕阈值 */
  private readonly SEQUENCE_WRAP_THRESHOLD = 65535;

  constructor(private readonly redis: RedisService) {}

  /**
   * 检查事件是否已处理（幂等校验）
   *
   * @param deviceId 设备 ID
   * @param localSequence 设备本地序列号
   * @returns 是否已处理
   */
  async isProcessed(deviceId: string, localSequence: number): Promise<boolean> {
    const key = this.buildIdempotencyKey(deviceId, localSequence);
    const exists = await this.redis.exists(key);
    return exists;
  }

  /**
   * 标记事件为已处理
   *
   * @param deviceId 设备 ID
   * @param localSequence 设备本地序列号
   * @param eventId 事件 ID（用于追溯）
   */
  async markProcessed(deviceId: string, localSequence: number, eventId?: string): Promise<void> {
    const key = this.buildIdempotencyKey(deviceId, localSequence);
    await this.redis.set(key, eventId || 'processed', this.IDEMPOTENCY_TTL);
  }

  /**
   * 执行幂等校验并处理
   *
   * 如果事件已处理，返回缓存的处理结果；
   * 如果未处理，执行处理函数并缓存结果。
   *
   * @param deviceId 设备 ID
   * @param localSequence 设备本地序列号
   * @param handler 处理函数
   * @returns 处理结果
   */
  async executeWithIdempotency<T>(
    deviceId: string,
    localSequence: number,
    handler: () => Promise<T>,
  ): Promise<{ result: T; isDuplicate: boolean }> {
    const key = this.buildIdempotencyKey(deviceId, localSequence);

    // 检查是否已处理
    const cached = await this.redis.get(key);
    if (cached) {
      this.logger.debug(`幂等命中: device=${deviceId}, seq=${localSequence}`);
      try {
        return { result: JSON.parse(cached) as T, isDuplicate: true };
      } catch {
        return { result: cached as unknown as T, isDuplicate: true };
      }
    }

    // 执行处理
    const result = await handler();

    // 缓存结果
    try {
      await this.redis.set(key, JSON.stringify(result), this.IDEMPOTENCY_TTL);
    } catch (error) {
      this.logger.warn(`幂等结果缓存失败: ${error.message}`);
    }

    return { result, isDuplicate: false };
  }

  /**
   * 检查序列号是否乱序
   *
   * @param deviceId 设备 ID
   * @param localSequence 设备本地序列号
   * @returns 序列号状态
   */
  async checkSequenceOrder(deviceId: string, localSequence: number): Promise<SequenceStatus> {
    const key = this.buildSequenceKey(deviceId);
    const lastSeqStr = await this.redis.get(key);
    const lastSeq = lastSeqStr ? parseInt(lastSeqStr, 10) : -1;

    if (lastSeq === -1) {
      return { status: 'first', expectedNext: 0, isOutOfOrder: false };
    }

    // 处理序列号回绕
    if (localSequence < lastSeq - this.SEQUENCE_WRAP_THRESHOLD / 2) {
      // 可能是回绕后的新序列号
      return { status: 'wrap_detected', expectedNext: 0, isOutOfOrder: false, lastSequence: lastSeq };
    }

    if (localSequence === lastSeq) {
      return { status: 'duplicate', expectedNext: lastSeq + 1, isOutOfOrder: false, lastSequence: lastSeq };
    }

    if (localSequence < lastSeq) {
      return { status: 'out_of_order', expectedNext: lastSeq + 1, isOutOfOrder: true, lastSequence: lastSeq };
    }

    if (localSequence > lastSeq + 1) {
      // 有数据丢失
      const missingCount = localSequence - lastSeq - 1;
      return {
        status: 'gap_detected',
        expectedNext: lastSeq + 1,
        isOutOfOrder: false,
        lastSequence: lastSeq,
        missingCount,
      };
    }

    return { status: 'in_order', expectedNext: localSequence + 1, isOutOfOrder: false, lastSequence: lastSeq };
  }

  /**
   * 更新最新序列号
   */
  async updateLastSequence(deviceId: string, localSequence: number): Promise<void> {
    const key = this.buildSequenceKey(deviceId);
    await this.redis.set(key, String(localSequence));
  }

  /**
   * 获取最新序列号
   */
  async getLastSequence(deviceId: string): Promise<number> {
    const key = this.buildSequenceKey(deviceId);
    const val = await this.redis.get(key);
    return val ? parseInt(val, 10) : -1;
  }

  /**
   * 批量幂等校验
   */
  async filterProcessed(deviceId: string, sequences: number[]): Promise<{ processed: number[]; unprocessed: number[] }> {
    const processed: number[] = [];
    const unprocessed: number[] = [];

    for (const seq of sequences) {
      const isProcessed = await this.isProcessed(deviceId, seq);
      if (isProcessed) {
        processed.push(seq);
      } else {
        unprocessed.push(seq);
      }
    }

    return { processed, unprocessed };
  }

  /**
   * 清除设备幂等记录（用于测试或设备重置）
   */
  async clearDeviceRecords(deviceId: string): Promise<void> {
    // 清除序列号追踪
    await this.redis.del(this.buildSequenceKey(deviceId));
    this.logger.log(`设备幂等记录已清除: device=${deviceId}`);
  }

  /**
   * 构建幂等键
   */
  private buildIdempotencyKey(deviceId: string, sequence: number): string {
    return `${this.IDEMPOTENCY_PREFIX}${deviceId}:${sequence}`;
  }

  /**
   * 构建序列号追踪键
   */
  private buildSequenceKey(deviceId: string): string {
    return `${this.SEQUENCE_PREFIX}${deviceId}`;
  }
}

/**
 * 序列号状态
 */
export interface SequenceStatus {
  status: 'first' | 'in_order' | 'out_of_order' | 'duplicate' | 'gap_detected' | 'wrap_detected';
  expectedNext: number;
  isOutOfOrder: boolean;
  lastSequence?: number;
  missingCount?: number;
}
