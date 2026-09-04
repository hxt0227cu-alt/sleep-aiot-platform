import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 序列号追踪服务
 *
 * 记录每个设备的最新上报序列号，检测数据丢失与乱序，
 * 触发补传机制。
 */
@Injectable()
export class SequenceTrackerService {
  private readonly logger = new Logger(SequenceTrackerService.name);

  /** 序列号状态前缀 */
  private readonly STATE_PREFIX = 'sequence:state:';

  /** 丢失序列号记录前缀 */
  private readonly MISSING_PREFIX = 'sequence:missing:';

  /** 状态保留时间（秒） */
  private readonly STATE_TTL = 30 * 24 * 60 * 60; // 30 天

  /** 丢失序列号保留时间（秒） */
  private readonly MISSING_TTL = 7 * 24 * 60 * 60; // 7 天

  /** 最大丢失记录数 */
  private readonly MAX_MISSING_RECORDS = 1000;

  constructor(private readonly redis: RedisService) {}

  /**
   * 记录设备序列号
   *
   * @param deviceId 设备 ID
   * @param sequence 序列号
   * @param timestamp 上报时间
   */
  async recordSequence(
    deviceId: string,
    sequence: number,
    timestamp?: number,
  ): Promise<SequenceRecordResult> {
    const stateKey = `${this.STATE_PREFIX}${deviceId}`;
    const now = timestamp || Date.now();

    // 获取当前状态
    const stateStr = await this.redis.get(stateKey);
    const state: DeviceSequenceState = stateStr
      ? JSON.parse(stateStr)
      : {
          deviceId,
          lastSequence: -1,
          lastTimestamp: 0,
          totalReceived: 0,
          totalDuplicate: 0,
          totalOutOfOrder: 0,
          totalMissing: 0,
          gaps: [],
        };

    const result: SequenceRecordResult = {
      sequence,
      previousSequence: state.lastSequence,
      isDuplicate: false,
      isOutOfOrder: false,
      isGap: false,
      missingSequences: [],
    };

    // 首次上报
    if (state.lastSequence === -1) {
      state.lastSequence = sequence;
      state.lastTimestamp = now;
      state.totalReceived = 1;
      await this.saveState(stateKey, state);
      return result;
    }

    // 重复
    if (sequence === state.lastSequence) {
      state.totalDuplicate++;
      result.isDuplicate = true;
      await this.saveState(stateKey, state);
      return result;
    }

    // 乱序（序列号小于上次，但不是回绕）
    if (
      sequence < state.lastSequence &&
      sequence > state.lastSequence - 32768
    ) {
      state.totalOutOfOrder++;
      result.isOutOfOrder = true;
      // 乱序数据仍记录，但不更新 lastSequence
      await this.saveState(stateKey, state);
      return result;
    }

    // 检测间隔（数据丢失）
    if (sequence > state.lastSequence + 1) {
      const missingCount = sequence - state.lastSequence - 1;
      state.totalMissing += missingCount;
      result.isGap = true;

      // 记录丢失的序列号
      const missingSeqs: number[] = [];
      for (let i = state.lastSequence + 1; i < sequence; i++) {
        missingSeqs.push(i);
      }
      result.missingSequences = missingSeqs;
      await this.recordMissingSequences(deviceId, missingSeqs);

      // 记录间隔
      state.gaps.push({
        from: state.lastSequence + 1,
        to: sequence - 1,
        count: missingCount,
        detectedAt: now,
      });
      // 限制间隔记录数量
      if (state.gaps.length > 100) {
        state.gaps = state.gaps.slice(-100);
      }
    }

    // 更新状态
    state.lastSequence = sequence;
    state.lastTimestamp = now;
    state.totalReceived++;

    await this.saveState(stateKey, state);
    return result;
  }

  /**
   * 获取设备序列号状态
   */
  async getDeviceState(deviceId: string): Promise<DeviceSequenceState | null> {
    const stateKey = `${this.STATE_PREFIX}${deviceId}`;
    const stateStr = await this.redis.get(stateKey);
    return stateStr ? JSON.parse(stateStr) : null;
  }

  /**
   * 获取丢失的序列号
   */
  async getMissingSequences(deviceId: string): Promise<number[]> {
    const missingKey = `${this.MISSING_PREFIX}${deviceId}`;
    const missingStr = await this.redis.get(missingKey);
    if (!missingStr) return [];
    try {
      const missing = JSON.parse(missingStr) as number[];
      return missing.slice(-this.MAX_MISSING_RECORDS);
    } catch {
      return [];
    }
  }

  /**
   * 标记丢失序列号已补传
   */
  async markMissingRecovered(
    deviceId: string,
    sequences: number[],
  ): Promise<void> {
    const missingKey = `${this.MISSING_PREFIX}${deviceId}`;
    const currentMissing = await this.getMissingSequences(deviceId);
    const recoveredSet = new Set(sequences);
    const remaining = currentMissing.filter((s) => !recoveredSet.has(s));

    if (remaining.length === 0) {
      await this.redis.del(missingKey);
    } else {
      await this.redis.set(
        missingKey,
        JSON.stringify(remaining),
        this.MISSING_TTL,
      );
    }

    this.logger.debug(
      `丢失序列号补传: device=${deviceId}, recovered=${sequences.length}, remaining=${remaining.length}`,
    );
  }

  /**
   * 触发设备补传
   *
   * 向设备发送补传指令，请求丢失的序列号数据。
   */
  async triggerBackfill(
    deviceId: string,
    missingSequences: number[],
  ): Promise<BackfillRequest> {
    this.logger.log(
      `触发数据补传: device=${deviceId}, missing=${missingSequences.length}`,
    );

    const request: BackfillRequest = {
      deviceId,
      missingSequences,
      requestedAt: new Date().toISOString(),
      requestId: `backfill-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      status: 'requested',
    };

    // 实际应通过 MQTT 向设备发送补传指令
    // await this.mqttService.publish(`device/${deviceId}/command/backfill`, request);

    return request;
  }

  /**
   * 获取设备序列号统计
   */
  async getDeviceStats(deviceId: string): Promise<SequenceStats | null> {
    const state = await this.getDeviceState(deviceId);
    if (!state) return null;

    const missing = await this.getMissingSequences(deviceId);

    return {
      deviceId,
      lastSequence: state.lastSequence,
      lastTimestamp: state.lastTimestamp,
      totalReceived: state.totalReceived,
      totalDuplicate: state.totalDuplicate,
      totalOutOfOrder: state.totalOutOfOrder,
      totalMissing: state.totalMissing,
      currentMissingCount: missing.length,
      duplicateRate:
        state.totalReceived > 0
          ? state.totalDuplicate / state.totalReceived
          : 0,
      outOfOrderRate:
        state.totalReceived > 0
          ? state.totalOutOfOrder / state.totalReceived
          : 0,
    };
  }

  /**
   * 记录丢失序列号
   */
  private async recordMissingSequences(
    deviceId: string,
    sequences: number[],
  ): Promise<void> {
    const missingKey = `${this.MISSING_PREFIX}${deviceId}`;
    const current = await this.getMissingSequences(deviceId);
    const updated = [...new Set([...current, ...sequences])].sort(
      (a, b) => a - b,
    );
    await this.redis.set(
      missingKey,
      JSON.stringify(updated.slice(-this.MAX_MISSING_RECORDS)),
      this.MISSING_TTL,
    );
  }

  /**
   * 保存状态
   */
  private async saveState(
    key: string,
    state: DeviceSequenceState,
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(state), this.STATE_TTL);
  }
}

/**
 * 设备序列号状态
 */
export interface DeviceSequenceState {
  deviceId: string;
  lastSequence: number;
  lastTimestamp: number;
  totalReceived: number;
  totalDuplicate: number;
  totalOutOfOrder: number;
  totalMissing: number;
  gaps: { from: number; to: number; count: number; detectedAt: number }[];
}

/**
 * 序列号记录结果
 */
export interface SequenceRecordResult {
  sequence: number;
  previousSequence: number;
  isDuplicate: boolean;
  isOutOfOrder: boolean;
  isGap: boolean;
  missingSequences: number[];
}

/**
 * 补传请求
 */
export interface BackfillRequest {
  deviceId: string;
  missingSequences: number[];
  requestedAt: string;
  requestId: string;
  status: 'requested' | 'in_progress' | 'completed' | 'failed';
}

/**
 * 序列号统计
 */
export interface SequenceStats {
  deviceId: string;
  lastSequence: number;
  lastTimestamp: number;
  totalReceived: number;
  totalDuplicate: number;
  totalOutOfOrder: number;
  totalMissing: number;
  currentMissingCount: number;
  duplicateRate: number;
  outOfOrderRate: number;
}
