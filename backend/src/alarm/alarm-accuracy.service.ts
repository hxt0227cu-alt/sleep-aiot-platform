import { Injectable, Logger } from '@nestjs/common';
import { AlarmAccuracyMetricsDto } from './dto/alarm-accuracy-metrics.dto';

/**
 * 报警准确率统计服务
 *
 * 基于标注数据按类型分别计算误报率、漏报率、灵敏度、特异度等指标，
 * 生成分类别报警效果评估报告。
 */
@Injectable()
export class AlarmAccuracyService {
  private readonly logger = new Logger(AlarmAccuracyService.name);

  /** 报警类型列表 */
  private readonly ALARM_TYPES = ['heart_rate', 'respiration', 'bed_exit', 'movement'] as const;

  /**
   * 计算单类型报警准确率指标
   *
   * @param data 混淆矩阵数据
   * @returns 计算后的指标
   */
  calculateMetrics(data: {
    alarmType: string;
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
  }): AlarmAccuracyMetricsDto {
    const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = data;

    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const falseAlarmRate = fp + tn > 0 ? fp / (fp + tn) : 0;
    const missRate = tp + fn > 0 ? fn / (tp + fn) : 0;
    const f1Score = precision + sensitivity > 0 ? (2 * precision * sensitivity) / (precision + sensitivity) : 0;

    return {
      ...data,
      sensitivity,
      specificity,
      precision,
      falseAlarmRate,
      missRate,
      f1Score,
      totalSamples: tp + fp + tn + fn,
    };
  }

  /**
   * 批量计算所有类型报警准确率
   */
  calculateAllMetrics(confusionMatrices: Array<{
    alarmType: string;
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
  }>): AlarmAccuracyMetricsDto[] {
    return confusionMatrices.map((matrix) => this.calculateMetrics(matrix));
  }

  /**
   * 对比两个版本的报警准确率（算法升级评估）
   */
  compareVersions(
    baseline: AlarmAccuracyMetricsDto[],
    current: AlarmAccuracyMetricsDto[],
  ): AlarmAccuracyComparison {
    const comparisons: Array<{
      alarmType: string;
      baselineSensitivity: number;
      currentSensitivity: number;
      sensitivityDelta: number;
      baselineSpecificity: number;
      currentSpecificity: number;
      specificityDelta: number;
      baselineFalseAlarmRate: number;
      currentFalseAlarmRate: number;
      falseAlarmDelta: number;
      degraded: boolean;
    }> = [];

    for (const type of this.ALARM_TYPES) {
      const base = baseline.find((b) => b.alarmType === type);
      const curr = current.find((c) => c.alarmType === type);

      if (base && curr) {
        const sensitivityDelta = (curr.sensitivity || 0) - (base.sensitivity || 0);
        const specificityDelta = (curr.specificity || 0) - (base.specificity || 0);
        const falseAlarmDelta = (curr.falseAlarmRate || 0) - (base.falseAlarmRate || 0);

        // 退化判定：灵敏度下降超过2%或特异度下降超过2%或误报率上升超过1%
        const degraded = sensitivityDelta < -0.02 || specificityDelta < -0.02 || falseAlarmDelta > 0.01;

        comparisons.push({
          alarmType: type,
          baselineSensitivity: base.sensitivity || 0,
          currentSensitivity: curr.sensitivity || 0,
          sensitivityDelta,
          baselineSpecificity: base.specificity || 0,
          currentSpecificity: curr.specificity || 0,
          specificityDelta,
          baselineFalseAlarmRate: base.falseAlarmRate || 0,
          currentFalseAlarmRate: curr.falseAlarmRate || 0,
          falseAlarmDelta,
          degraded,
        });
      }
    }

    const anyDegraded = comparisons.some((c) => c.degraded);

    return {
      comparisons,
      overallDegraded: anyDegraded,
      summary: {
        typesEvaluated: comparisons.length,
        degradedTypes: comparisons.filter((c) => c.degraded).map((c) => c.alarmType),
        passedTypes: comparisons.filter((c) => !c.degraded).map((c) => c.alarmType),
      },
    };
  }

  /**
   * 生成报警准确率评估报告
   */
  generateReport(metrics: AlarmAccuracyMetricsDto[], datasetVersion: string, algorithmVersion: string): AlarmAccuracyReport {
    const testedAt = new Date().toISOString();

    const report: AlarmAccuracyReport = {
      reportId: `alarm-accuracy-${Date.now()}`,
      generatedAt: testedAt,
      datasetVersion,
      algorithmVersion,
      metrics: metrics.map((m) => ({ ...m, testedAt })),
      summary: {
        totalTypes: metrics.length,
        averageSensitivity: metrics.length > 0 ? metrics.reduce((acc, m) => acc + (m.sensitivity || 0), 0) / metrics.length : 0,
        averageSpecificity: metrics.length > 0 ? metrics.reduce((acc, m) => acc + (m.specificity || 0), 0) / metrics.length : 0,
        averageFalseAlarmRate: metrics.length > 0 ? metrics.reduce((acc, m) => acc + (m.falseAlarmRate || 0), 0) / metrics.length : 0,
        totalSamples: metrics.reduce((acc, m) => acc + (m.totalSamples || 0), 0),
      },
      passStatus: this.evaluatePassStatus(metrics),
    };

    this.logger.log(`报警准确率报告生成: algorithm=${algorithmVersion}, dataset=${datasetVersion}, pass=${report.passStatus.passed}`);
    return report;
  }

  /**
   * 评估是否通过验收阈值
   */
  private evaluatePassStatus(metrics: AlarmAccuracyMetricsDto[]): { passed: boolean; failedTypes: string[]; details: Record<string, string> } {
    const thresholds: Record<string, { sensitivity: number; specificity: number; falseAlarmRate: number }> = {
      heart_rate: { sensitivity: 0.90, specificity: 0.95, falseAlarmRate: 0.05 },
      respiration: { sensitivity: 0.88, specificity: 0.96, falseAlarmRate: 0.04 },
      bed_exit: { sensitivity: 0.95, specificity: 0.98, falseAlarmRate: 0.02 },
      movement: { sensitivity: 0.85, specificity: 0.93, falseAlarmRate: 0.07 },
    };

    const failedTypes: string[] = [];
    const details: Record<string, string> = {};

    for (const metric of metrics) {
      const threshold = thresholds[metric.alarmType];
      if (!threshold) continue;

      const issues: string[] = [];
      if ((metric.sensitivity || 0) < threshold.sensitivity) {
        issues.push(`灵敏度 ${((metric.sensitivity || 0) * 100).toFixed(1)}% < 阈值 ${(threshold.sensitivity * 100).toFixed(1)}%`);
      }
      if ((metric.specificity || 0) < threshold.specificity) {
        issues.push(`特异度 ${((metric.specificity || 0) * 100).toFixed(1)}% < 阈值 ${(threshold.specificity * 100).toFixed(1)}%`);
      }
      if ((metric.falseAlarmRate || 0) > threshold.falseAlarmRate) {
        issues.push(`误报率 ${((metric.falseAlarmRate || 0) * 100).toFixed(1)}% > 阈值 ${(threshold.falseAlarmRate * 100).toFixed(1)}%`);
      }

      if (issues.length > 0) {
        failedTypes.push(metric.alarmType);
        details[metric.alarmType] = issues.join('; ');
      } else {
        details[metric.alarmType] = '通过';
      }
    }

    return { passed: failedTypes.length === 0, failedTypes, details };
  }
}

/**
 * 报警准确率对比结果
 */
export interface AlarmAccuracyComparison {
  comparisons: Array<{
    alarmType: string;
    baselineSensitivity: number;
    currentSensitivity: number;
    sensitivityDelta: number;
    baselineSpecificity: number;
    currentSpecificity: number;
    specificityDelta: number;
    baselineFalseAlarmRate: number;
    currentFalseAlarmRate: number;
    falseAlarmDelta: number;
    degraded: boolean;
  }>;
  overallDegraded: boolean;
  summary: {
    typesEvaluated: number;
    degradedTypes: string[];
    passedTypes: string[];
  };
}

/**
 * 报警准确率评估报告
 */
export interface AlarmAccuracyReport {
  reportId: string;
  generatedAt: string;
  datasetVersion: string;
  algorithmVersion: string;
  metrics: AlarmAccuracyMetricsDto[];
  summary: {
    totalTypes: number;
    averageSensitivity: number;
    averageSpecificity: number;
    averageFalseAlarmRate: number;
    totalSamples: number;
  };
  passStatus: {
    passed: boolean;
    failedTypes: string[];
    details: Record<string, string>;
  };
}
