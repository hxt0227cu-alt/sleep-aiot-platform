import { Injectable, Logger } from '@nestjs/common';

/**
 * 报警基线管理服务
 *
 * 加载各类型报警的评测阈值与通过标准，
 * 校验算法升级后的退化风险。
 */
@Injectable()
export class AlarmBaselineService {
  private readonly logger = new Logger(AlarmBaselineService.name);

  /** 报警基线配置 */
  private baselines: Map<string, AlarmBaseline> = new Map();

  constructor() {
    this.initializeDefaultBaselines();
  }

  /**
   * 初始化默认基线
   */
  private initializeDefaultBaselines(): void {
    const defaultBaselines: AlarmBaseline[] = [
      {
        alarmType: 'heart_rate',
        version: '1.0.0',
        thresholds: {
          sensitivity: 0.9,
          specificity: 0.95,
          precision: 0.85,
          falseAlarmRate: 0.05,
          missRate: 0.1,
          f1Score: 0.87,
        },
        edgeLatencyMs: 2000,
        notificationLatencyMs: 15000,
        datasetVersion: 'sleep-alarm-benchmark-v1.0',
        description: '心率异常报警基线',
      },
      {
        alarmType: 'respiration',
        version: '1.0.0',
        thresholds: {
          sensitivity: 0.88,
          specificity: 0.96,
          precision: 0.85,
          falseAlarmRate: 0.04,
          missRate: 0.12,
          f1Score: 0.86,
        },
        edgeLatencyMs: 2000,
        notificationLatencyMs: 15000,
        datasetVersion: 'sleep-alarm-benchmark-v1.0',
        description: '呼吸异常报警基线',
      },
      {
        alarmType: 'bed_exit',
        version: '1.0.0',
        thresholds: {
          sensitivity: 0.95,
          specificity: 0.98,
          precision: 0.95,
          falseAlarmRate: 0.02,
          missRate: 0.05,
          f1Score: 0.95,
        },
        edgeLatencyMs: 1000,
        notificationLatencyMs: 10000,
        datasetVersion: 'sleep-alarm-benchmark-v1.0',
        description: '离床检测报警基线',
      },
      {
        alarmType: 'movement',
        version: '1.0.0',
        thresholds: {
          sensitivity: 0.85,
          specificity: 0.93,
          precision: 0.8,
          falseAlarmRate: 0.07,
          missRate: 0.15,
          f1Score: 0.82,
        },
        edgeLatencyMs: 2000,
        notificationLatencyMs: 15000,
        datasetVersion: 'sleep-alarm-benchmark-v1.0',
        description: '体动异常报警基线',
      },
    ];

    for (const baseline of defaultBaselines) {
      this.baselines.set(baseline.alarmType, baseline);
    }

    this.logger.log(`报警基线初始化完成: ${defaultBaselines.length} 种类型`);
  }

  /**
   * 获取指定类型的报警基线
   */
  getBaseline(alarmType: string): AlarmBaseline | undefined {
    return this.baselines.get(alarmType);
  }

  /**
   * 获取所有基线
   */
  getAllBaselines(): AlarmBaseline[] {
    return Array.from(this.baselines.values());
  }

  /**
   * 校验算法指标是否满足基线要求
   */
  validateAgainstBaseline(
    alarmType: string,
    metrics: {
      sensitivity?: number;
      specificity?: number;
      precision?: number;
      falseAlarmRate?: number;
      missRate?: number;
      f1Score?: number;
    },
  ): BaselineValidationResult {
    const baseline = this.baselines.get(alarmType);
    if (!baseline) {
      return {
        passed: false,
        alarmType,
        errors: [`未找到报警类型 ${alarmType} 的基线配置`],
        checks: [],
      };
    }

    const checks: BaselineCheck[] = [];
    const errors: string[] = [];

    // 灵敏度检查
    if (metrics.sensitivity !== undefined) {
      const passed = metrics.sensitivity >= baseline.thresholds.sensitivity;
      checks.push({
        metric: 'sensitivity',
        value: metrics.sensitivity,
        threshold: baseline.thresholds.sensitivity,
        passed,
      });
      if (!passed)
        errors.push(
          `灵敏度 ${(metrics.sensitivity * 100).toFixed(1)}% 低于基线 ${(baseline.thresholds.sensitivity * 100).toFixed(1)}%`,
        );
    }

    // 特异度检查
    if (metrics.specificity !== undefined) {
      const passed = metrics.specificity >= baseline.thresholds.specificity;
      checks.push({
        metric: 'specificity',
        value: metrics.specificity,
        threshold: baseline.thresholds.specificity,
        passed,
      });
      if (!passed)
        errors.push(
          `特异度 ${(metrics.specificity * 100).toFixed(1)}% 低于基线 ${(baseline.thresholds.specificity * 100).toFixed(1)}%`,
        );
    }

    // 误报率检查
    if (metrics.falseAlarmRate !== undefined) {
      const passed =
        metrics.falseAlarmRate <= baseline.thresholds.falseAlarmRate;
      checks.push({
        metric: 'falseAlarmRate',
        value: metrics.falseAlarmRate,
        threshold: baseline.thresholds.falseAlarmRate,
        passed,
      });
      if (!passed)
        errors.push(
          `误报率 ${(metrics.falseAlarmRate * 100).toFixed(1)}% 高于基线 ${(baseline.thresholds.falseAlarmRate * 100).toFixed(1)}%`,
        );
    }

    // 漏报率检查
    if (metrics.missRate !== undefined) {
      const passed = metrics.missRate <= baseline.thresholds.missRate;
      checks.push({
        metric: 'missRate',
        value: metrics.missRate,
        threshold: baseline.thresholds.missRate,
        passed,
      });
      if (!passed)
        errors.push(
          `漏报率 ${(metrics.missRate * 100).toFixed(1)}% 高于基线 ${(baseline.thresholds.missRate * 100).toFixed(1)}%`,
        );
    }

    return {
      passed: errors.length === 0,
      alarmType,
      errors,
      checks,
      baselineVersion: baseline.version,
    };
  }

  /**
   * 检测算法升级退化风险
   *
   * 对比新版本与基线版本的指标，检测是否存在显著退化。
   */
  detectDegradationRisk(
    alarmType: string,
    newMetrics: Record<string, number>,
    degradationThreshold: number = 0.02,
  ): DegradationRiskResult {
    const baseline = this.baselines.get(alarmType);
    if (!baseline) {
      return {
        hasRisk: true,
        alarmType,
        reason: '未找到基线配置',
        details: [],
      };
    }

    const details: DegradationDetail[] = [];
    let hasRisk = false;

    for (const [metric, baselineValue] of Object.entries(baseline.thresholds)) {
      const newValue = newMetrics[metric];
      if (newValue === undefined) continue;

      // 对于灵敏度、特异度、精确率、F1，值越低越差
      // 对于误报率、漏报率，值越高越差
      const higherIsBetter = [
        'sensitivity',
        'specificity',
        'precision',
        'f1Score',
      ].includes(metric);
      const delta = higherIsBetter
        ? newValue - baselineValue
        : baselineValue - newValue;

      if (delta < -degradationThreshold) {
        hasRisk = true;
        details.push({
          metric,
          baselineValue,
          newValue,
          delta,
          severity:
            Math.abs(delta) > degradationThreshold * 2 ? 'high' : 'medium',
          description: `${metric} 退化 ${Math.abs(delta * 100).toFixed(1)}%`,
        });
      }
    }

    return {
      hasRisk,
      alarmType,
      reason: hasRisk ? '检测到指标退化' : '无退化风险',
      details,
    };
  }

  /**
   * 更新基线配置
   */
  updateBaseline(alarmType: string, updates: Partial<AlarmBaseline>): void {
    const existing = this.baselines.get(alarmType);
    if (existing) {
      this.baselines.set(alarmType, { ...existing, ...updates });
      this.logger.log(`报警基线已更新: ${alarmType}`);
    }
  }
}

/**
 * 报警基线
 */
export interface AlarmBaseline {
  alarmType: string;
  version: string;
  thresholds: {
    sensitivity: number;
    specificity: number;
    precision: number;
    falseAlarmRate: number;
    missRate: number;
    f1Score: number;
  };
  edgeLatencyMs: number;
  notificationLatencyMs: number;
  datasetVersion: string;
  description: string;
}

/**
 * 基线校验结果
 */
export interface BaselineValidationResult {
  passed: boolean;
  alarmType: string;
  errors: string[];
  checks: BaselineCheck[];
  baselineVersion?: string;
}

/**
 * 基线检查项
 */
interface BaselineCheck {
  metric: string;
  value: number;
  threshold: number;
  passed: boolean;
}

/**
 * 退化风险结果
 */
export interface DegradationRiskResult {
  hasRisk: boolean;
  alarmType: string;
  reason: string;
  details: DegradationDetail[];
}

/**
 * 退化详情
 */
interface DegradationDetail {
  metric: string;
  baselineValue: number;
  newValue: number;
  delta: number;
  severity: 'low' | 'medium' | 'high';
  description: string;
}
