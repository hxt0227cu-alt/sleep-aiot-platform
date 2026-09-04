import { IsNumber, IsOptional, IsString, Min, Max } from 'class-validator';

/**
 * 报警准确率指标 DTO（按类型分项）
 */
export class AlarmAccuracyMetricsDto {
  /** 报警类型：heart_rate / respiration / bed_exit / movement */
  @IsString()
  alarmType: string;

  /** 真阳性（正确报警数） */
  @IsNumber()
  @Min(0)
  truePositives: number;

  /** 假阳性（误报数） */
  @IsNumber()
  @Min(0)
  falsePositives: number;

  /** 真阴性（正确未报警数） */
  @IsNumber()
  @Min(0)
  trueNegatives: number;

  /** 假阴性（漏报数） */
  @IsNumber()
  @Min(0)
  falseNegatives: number;

  /** 灵敏度（召回率）= TP / (TP + FN) */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  sensitivity?: number;

  /** 特异度 = TN / (TN + FP) */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  specificity?: number;

  /** 精确率 = TP / (TP + FP) */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  precision?: number;

  /** 误报率 = FP / (FP + TN) */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  falseAlarmRate?: number;

  /** 漏报率 = FN / (TP + FN) */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  missRate?: number;

  /** F1 分数 */
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1)
  f1Score?: number;

  /** 测试样本总数 */
  @IsNumber()
  @IsOptional()
  @Min(0)
  totalSamples?: number;

  /** 测试数据集版本 */
  @IsString()
  @IsOptional()
  datasetVersion?: string;

  /** 算法版本 */
  @IsString()
  @IsOptional()
  algorithmVersion?: string;

  /** 测试时间 */
  @IsString()
  @IsOptional()
  testedAt?: string;
}
