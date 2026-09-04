import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface VitalSignsData {
  deviceId: string;
  timestamp: Date;
  heartRate?: number;
  breathingRate?: number;
  bodyMovement?: number;
  sleepState?: string;
  sleepScore?: number;
  confidence?: number;
}

export interface AlarmRule {
  id: number;
  deviceId: string;
  type: string;
  enabled: boolean;
  threshold: number;
  duration: number;
  actions: string[];
}

export interface AlarmTriggerResult {
  triggered: boolean;
  rule: AlarmRule;
  value: number;
  threshold: number;
  message: string;
  level: string;
}

export interface RuleEvaluationContext {
  deviceId: string;
  vitalSigns: VitalSignsData;
  historicalData?: VitalSignsData[];
  timestamp: Date;
}

@Injectable()
export class AlarmRuleEngineService {
  private readonly logger = new Logger(AlarmRuleEngineService.name);
  private readonly alarmCooldowns = new Map<string, number>();
  private readonly alarmStateHistory = new Map<string, VitalSignsData[]>();
  private readonly MAX_HISTORY_SIZE = 100;
  private readonly DEFAULT_COOLDOWN_PERIOD = 300000; // 5分钟

  constructor(private prisma: PrismaService) {}

  /**
   * 评估设备的所有报警规则
   */
  async evaluateDeviceRules(
    context: RuleEvaluationContext,
  ): Promise<AlarmTriggerResult[]> {
    const { deviceId, vitalSigns } = context;

    // 更新历史数据
    this.updateHistoryData(deviceId, vitalSigns);

    // 获取设备所有启用的报警规则
    const rules = await this.getEnabledRules(deviceId);

    if (rules.length === 0) {
      this.logger.debug(`No enabled alarm rules for device ${deviceId}`);
      return [];
    }

    const results: AlarmTriggerResult[] = [];

    for (const rule of rules) {
      try {
        const result = await this.evaluateRule(rule, context);
        if (result.triggered) {
          results.push(result);
        }
      } catch (error) {
        this.logger.error(
          `Error evaluating rule ${rule.type} for device ${deviceId}:`,
          error,
        );
      }
    }

    return results;
  }

  /**
   * 评估单个报警规则
   */
  async evaluateRule(
    rule: AlarmRule,
    context: RuleEvaluationContext,
  ): Promise<AlarmTriggerResult> {
    const { deviceId, vitalSigns, historicalData } = context;

    // 检查冷却期
    if (this.isInCooldown(deviceId, rule.type, rule.duration)) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Alarm in cooldown period',
        level: 'info',
      };
    }

    // 根据规则类型评估
    const evaluation = this.evaluateRuleByType(
      rule,
      vitalSigns,
      historicalData,
    );

    if (evaluation.triggered) {
      // 设置冷却期
      this.setCooldown(deviceId, rule.type);
    }

    return evaluation;
  }

  /**
   * 根据规则类型进行评估
   */
  private evaluateRuleByType(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    const { type, threshold } = rule;

    switch (type) {
      case 'heart_rate_high':
        return this.evaluateHeartRateHigh(rule, vitalSigns, historicalData);
      case 'heart_rate_low':
        return this.evaluateHeartRateLow(rule, vitalSigns, historicalData);
      case 'breathing_rate_high':
        return this.evaluateBreathingRateHigh(rule, vitalSigns, historicalData);
      case 'breathing_rate_low':
        return this.evaluateBreathingRateLow(rule, vitalSigns, historicalData);
      case 'no_movement':
        return this.evaluateNoMovement(rule, vitalSigns, historicalData);
      case 'sleep_score_low':
        return this.evaluateSleepScoreLow(rule, vitalSigns, historicalData);
      case 'abnormal_sleep_state':
        return this.evaluateAbnormalSleepState(
          rule,
          vitalSigns,
          historicalData,
        );
      default:
        this.logger.warn(`Unknown alarm rule type: ${type}`);
        return {
          triggered: false,
          rule,
          value: 0,
          threshold,
          message: 'Unknown rule type',
          level: 'info',
        };
    }
  }

  /**
   * 评估心率过高规则
   */
  private evaluateHeartRateHigh(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.heartRate === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Heart rate data not available',
        level: 'info',
      };
    }

    const triggered = vitalSigns.heartRate > rule.threshold;

    return {
      triggered,
      rule,
      value: vitalSigns.heartRate,
      threshold: rule.threshold,
      message: triggered
        ? `心率异常偏高: ${vitalSigns.heartRate} BPM (阈值: ${rule.threshold} BPM)`
        : 'Heart rate normal',
      level: triggered ? 'critical' : 'info',
    };
  }

  /**
   * 评估心率过低规则
   */
  private evaluateHeartRateLow(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.heartRate === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Heart rate data not available',
        level: 'info',
      };
    }

    const triggered = vitalSigns.heartRate < rule.threshold;

    return {
      triggered,
      rule,
      value: vitalSigns.heartRate,
      threshold: rule.threshold,
      message: triggered
        ? `心率异常偏低: ${vitalSigns.heartRate} BPM (阈值: ${rule.threshold} BPM)`
        : 'Heart rate normal',
      level: triggered ? 'critical' : 'info',
    };
  }

  /**
   * 评估呼吸频率过高规则
   */
  private evaluateBreathingRateHigh(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.breathingRate === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Breathing rate data not available',
        level: 'info',
      };
    }

    const triggered = vitalSigns.breathingRate > rule.threshold;

    return {
      triggered,
      rule,
      value: vitalSigns.breathingRate,
      threshold: rule.threshold,
      message: triggered
        ? `呼吸频率异常偏高: ${vitalSigns.breathingRate} 次/分 (阈值: ${rule.threshold} 次/分)`
        : 'Breathing rate normal',
      level: triggered ? 'warning' : 'info',
    };
  }

  /**
   * 评估呼吸频率过低规则
   */
  private evaluateBreathingRateLow(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.breathingRate === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Breathing rate data not available',
        level: 'info',
      };
    }

    const triggered = vitalSigns.breathingRate < rule.threshold;

    return {
      triggered,
      rule,
      value: vitalSigns.breathingRate,
      threshold: rule.threshold,
      message: triggered
        ? `呼吸频率异常偏低: ${vitalSigns.breathingRate} 次/分 (阈值: ${rule.threshold} 次/分)`
        : 'Breathing rate normal',
      level: triggered ? 'critical' : 'info',
    };
  }

  /**
   * 评估无体动规则
   */
  private evaluateNoMovement(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.bodyMovement === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Body movement data not available',
        level: 'info',
      };
    }

    // 检查历史数据是否持续无体动
    const durationThreshold = rule.duration * 60; // 转换为秒
    const noMovementDuration = this.calculateNoMovementDuration(
      historicalData || [],
    );

    const triggered =
      vitalSigns.bodyMovement < rule.threshold &&
      noMovementDuration >= durationThreshold;

    return {
      triggered,
      rule,
      value: vitalSigns.bodyMovement,
      threshold: rule.threshold,
      message: triggered
        ? `长时间无体动: ${Math.floor(noMovementDuration / 60)} 分钟 (阈值: ${rule.duration} 分钟)`
        : 'Body movement normal',
      level: triggered ? 'critical' : 'info',
    };
  }

  /**
   * 评估睡眠评分过低规则
   */
  private evaluateSleepScoreLow(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.sleepScore === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Sleep score data not available',
        level: 'info',
      };
    }

    const triggered = vitalSigns.sleepScore < rule.threshold;

    return {
      triggered,
      rule,
      value: vitalSigns.sleepScore,
      threshold: rule.threshold,
      message: triggered
        ? `睡眠评分过低: ${vitalSigns.sleepScore} (阈值: ${rule.threshold})`
        : 'Sleep score normal',
      level: triggered ? 'warning' : 'info',
    };
  }

  /**
   * 评估异常睡眠状态规则
   */
  private evaluateAbnormalSleepState(
    rule: AlarmRule,
    vitalSigns: VitalSignsData,
    historicalData?: VitalSignsData[],
  ): AlarmTriggerResult {
    if (vitalSigns.sleepState === undefined) {
      return {
        triggered: false,
        rule,
        value: 0,
        threshold: rule.threshold,
        message: 'Sleep state data not available',
        level: 'info',
      };
    }

    // 检查是否处于异常睡眠状态
    const abnormalStates = ['awake', 'restless', 'unknown'];
    const triggered = abnormalStates.includes(vitalSigns.sleepState);

    return {
      triggered,
      rule,
      value: vitalSigns.sleepState === 'awake' ? 1 : 0,
      threshold: rule.threshold,
      message: triggered
        ? `异常睡眠状态: ${vitalSigns.sleepState}`
        : 'Sleep state normal',
      level: triggered ? 'warning' : 'info',
    };
  }

  /**
   * 计算无体动持续时间
   */
  private calculateNoMovementDuration(history: VitalSignsData[]): number {
    if (history.length === 0) {
      return 0;
    }

    let duration = 0;
    const movementThreshold = 0.1; // 体动阈值

    // 从最新数据开始向前检查
    for (let i = history.length - 1; i >= 0; i--) {
      const data = history[i];
      if (
        data.bodyMovement !== undefined &&
        data.bodyMovement < movementThreshold
      ) {
        // 计算时间差
        if (i < history.length - 1) {
          const timeDiff =
            (history[i + 1].timestamp.getTime() - data.timestamp.getTime()) /
            1000;
          duration += timeDiff;
        }
      } else {
        break;
      }
    }

    return duration;
  }

  /**
   * 获取设备启用的报警规则
   */
  private async getEnabledRules(deviceId: string): Promise<AlarmRule[]> {
    const configs = await this.prisma.alarmConfig.findMany({
      where: {
        deviceId,
        enabled: true,
      },
    });

    return configs.map((config) => ({
      id: config.id,
      deviceId: config.deviceId,
      type: config.type,
      enabled: config.enabled,
      threshold: Number(config.threshold),
      duration: config.duration,
      actions: config.actions as string[],
    }));
  }

  /**
   * 检查是否在冷却期
   */
  private isInCooldown(
    deviceId: string,
    ruleType: string,
    duration: number,
  ): boolean {
    const cooldownKey = `${deviceId}_${ruleType}`;
    const lastTriggered = this.alarmCooldowns.get(cooldownKey);

    if (!lastTriggered) {
      return false;
    }

    const cooldownPeriod = duration * 1000; // 转换为毫秒
    const now = Date.now();

    return now - lastTriggered < cooldownPeriod;
  }

  /**
   * 设置冷却期
   */
  private setCooldown(deviceId: string, ruleType: string): void {
    const cooldownKey = `${deviceId}_${ruleType}`;
    this.alarmCooldowns.set(cooldownKey, Date.now());
  }

  /**
   * 更新历史数据
   */
  private updateHistoryData(
    deviceId: string,
    vitalSigns: VitalSignsData,
  ): void {
    const history = this.alarmStateHistory.get(deviceId) || [];
    history.push(vitalSigns);

    // 限制历史数据大小
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.shift();
    }

    this.alarmStateHistory.set(deviceId, history);
  }

  /**
   * 清除设备的冷却期
   */
  clearCooldown(deviceId: string, ruleType?: string): void {
    if (ruleType) {
      const cooldownKey = `${deviceId}_${ruleType}`;
      this.alarmCooldowns.delete(cooldownKey);
    } else {
      // 清除设备所有冷却期
      for (const key of this.alarmCooldowns.keys()) {
        if (key.startsWith(`${deviceId}_`)) {
          this.alarmCooldowns.delete(key);
        }
      }
    }
  }

  /**
   * 清除设备的历史数据
   */
  clearHistoryData(deviceId: string): void {
    this.alarmStateHistory.delete(deviceId);
  }

  /**
   * 获取报警规则统计信息
   */
  async getRuleStatistics(deviceId: string): Promise<{
    totalRules: number;
    enabledRules: number;
    disabledRules: number;
    rules: Array<{
      type: string;
      enabled: boolean;
      threshold: number;
      duration: number;
      actions: string[];
    }>;
  }> {
    const configs = await this.prisma.alarmConfig.findMany({
      where: { deviceId },
    });

    const enabledRules = configs.filter((c) => c.enabled).length;
    const disabledRules = configs.length - enabledRules;

    return {
      totalRules: configs.length,
      enabledRules,
      disabledRules,
      rules: configs.map((config) => ({
        type: config.type,
        enabled: config.enabled,
        threshold: Number(config.threshold),
        duration: config.duration,
        actions: config.actions as string[],
      })),
    };
  }
}
