import { Injectable, Logger } from '@nestjs/common';

/**
 * 睡眠数据重算服务
 *
 * 算法版本更新后支持批量重算历史数据，
 * 生成对应版本的正式报告，重算过程不影响线上实时数据。
 */
@Injectable()
export class SleepRecalcService {
  private readonly logger = new Logger(SleepRecalcService.name);

  /** 重算任务存储 */
  private recalcTasks: Map<string, RecalcTask> = new Map();

  /** 并发重算限制 */
  private readonly MAX_CONCURRENT_RECALC = 3;

  /** 当前运行中的重算数 */
  private runningCount = 0;

  /**
   * 创建睡眠数据重算任务
   *
   * @param request 重算请求
   * @returns 重算任务
   */
  createRecalcTask(request: RecalcRequest): RecalcTask {
    const taskId = `recalc-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const task: RecalcTask = {
      taskId,
      status: 'pending',
      algorithmVersion: request.algorithmVersion,
      previousAlgorithmVersion: request.previousAlgorithmVersion,
      dateRange: request.dateRange,
      deviceIds: request.deviceIds,
      userIds: request.userIds,
      tenantId: request.tenantId,
      totalRecords: 0,
      processedRecords: 0,
      failedRecords: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      resultSummary: null,
    };

    this.recalcTasks.set(taskId, task);
    this.logger.log(`重算任务创建: ${taskId}, algorithm=${request.algorithmVersion}, range=${request.dateRange.start}~${request.dateRange.end}`);

    // 异步执行重算
    this.executeRecalc(task).catch((err) => {
      this.logger.error(`重算任务异常: ${taskId}, error=${err.message}`);
    });

    return task;
  }

  /**
   * 执行重算任务
   */
  private async executeRecalc(task: RecalcTask): Promise<void> {
    // 等待并发槽位
    while (this.runningCount >= this.MAX_CONCURRENT_RECALC) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.runningCount++;
    task.status = 'running';
    task.startedAt = new Date().toISOString();

    try {
      this.logger.log(`重算任务开始: ${task.taskId}`);

      // 1. 查询需要重算的睡眠记录
      const recordsToRecalc = await this.queryRecordsToRecalc(task);
      task.totalRecords = recordsToRecalc.length;

      this.logger.log(`重算任务: 找到 ${task.totalRecords} 条记录需要重算`);

      // 2. 逐条重算
      const results: RecalcResult[] = [];
      for (let i = 0; i < recordsToRecalc.length; i++) {
        const record = recordsToRecalc[i];

        try {
          const result = await this.recalcSingleRecord(record, task.algorithmVersion);
          results.push(result);
          task.processedRecords++;
        } catch (error) {
          task.failedRecords++;
          this.logger.error(`重算记录失败: record=${record.id}, error=${error.message}`);
        }

        // 更新进度（每100条）
        if (i % 100 === 0 && i > 0) {
          this.logger.debug(`重算进度: ${task.taskId}, ${task.processedRecords}/${task.totalRecords}`);
        }
      }

      // 3. 生成结果摘要
      task.resultSummary = this.generateResultSummary(results, task);
      task.status = 'completed';
      task.completedAt = new Date().toISOString();

      this.logger.log(
        `重算任务完成: ${task.taskId}, total=${task.totalRecords}, ` +
        `processed=${task.processedRecords}, failed=${task.failedRecords}`,
      );
    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
      task.completedAt = new Date().toISOString();
      this.logger.error(`重算任务失败: ${task.taskId}, error=${error.message}`);
    } finally {
      this.runningCount--;
    }
  }

  /**
   * 查询需要重算的记录
   */
  private async queryRecordsToRecalc(task: RecalcTask): Promise<SleepRecord[]> {
    // 实际应从数据库查询
    // const records = await this.prisma.sleepReport.findMany({
    //   where: {
    //     date: { gte: task.dateRange.start, lte: task.dateRange.end },
    //     deviceId: task.deviceIds ? { in: task.deviceIds } : undefined,
    //     algorithmVersion: { not: task.algorithmVersion },
    //   },
    // });

    // 模拟返回空列表
    this.logger.debug(`查询重算记录: task=${task.taskId}`);
    return [];
  }

  /**
   * 重算单条睡眠记录
   */
  private async recalcSingleRecord(record: SleepRecord, newAlgorithmVersion: string): Promise<RecalcResult> {
    // 实际应调用算法服务重算
    // const newResult = await this.algorithmService.calculateSleepStage(record.rawData, newAlgorithmVersion);

    // 模拟重算
    return {
      recordId: record.id,
      deviceId: record.deviceId,
      date: record.date,
      previousAlgorithmVersion: record.algorithmVersion,
      newAlgorithmVersion,
      previousSleepScore: record.sleepScore,
      newSleepScore: record.sleepScore, // 模拟无变化
      sleepStageChanges: [],
      recalculatedAt: new Date().toISOString(),
    };
  }

  /**
   * 生成重算结果摘要
   */
  private generateResultSummary(results: RecalcResult[], task: RecalcTask): RecalcResultSummary {
    const totalChanged = results.filter((r) => r.previousSleepScore !== r.newSleepScore).length;
    const scoreDiffs = results.map((r) => Math.abs(r.newSleepScore - r.previousSleepScore));
    const avgScoreDiff = scoreDiffs.length > 0 ? scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length : 0;

    return {
      totalRecords: results.length,
      changedRecords: totalChanged,
      unchangedRecords: results.length - totalChanged,
      averageScoreDiff: avgScoreDiff,
      maxScoreDiff: scoreDiffs.length > 0 ? Math.max(...scoreDiffs) : 0,
      algorithmVersion: task.algorithmVersion,
      previousAlgorithmVersion: task.previousAlgorithmVersion,
      dateRange: task.dateRange,
    };
  }

  /**
   * 获取重算任务状态
   */
  getRecalcTask(taskId: string): RecalcTask | null {
    return this.recalcTasks.get(taskId) || null;
  }

  /**
   * 列出重算任务
   */
  listRecalcTasks(tenantId?: string, status?: RecalcTaskStatus): RecalcTask[] {
    let tasks = Array.from(this.recalcTasks.values());
    if (tenantId) {
      tasks = tasks.filter((t) => t.tenantId === tenantId);
    }
    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 取消重算任务
   */
  cancelRecalcTask(taskId: string): boolean {
    const task = this.recalcTasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending' || task.status === 'running') {
      task.status = 'cancelled';
      task.completedAt = new Date().toISOString();
      this.logger.log(`重算任务已取消: ${taskId}`);
      return true;
    }

    return false;
  }

  /**
   * 获取重算进度
   */
  getRecalcProgress(taskId: string): { progress: number; processed: number; total: number; failed: number } | null {
    const task = this.recalcTasks.get(taskId);
    if (!task) return null;

    const progress = task.totalRecords > 0 ? (task.processedRecords / task.totalRecords) * 100 : 0;
    return {
      progress: Math.round(progress * 100) / 100,
      processed: task.processedRecords,
      total: task.totalRecords,
      failed: task.failedRecords,
    };
  }
}

/**
 * 重算请求
 */
export interface RecalcRequest {
  algorithmVersion: string;
  previousAlgorithmVersion?: string;
  dateRange: { start: string; end: string };
  deviceIds?: string[];
  userIds?: string[];
  tenantId?: string;
}

/**
 * 重算任务状态
 */
export type RecalcTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 重算任务
 */
export interface RecalcTask {
  taskId: string;
  status: RecalcTaskStatus;
  algorithmVersion: string;
  previousAlgorithmVersion?: string;
  dateRange: { start: string; end: string };
  deviceIds?: string[];
  userIds?: string[];
  tenantId?: string;
  totalRecords: number;
  processedRecords: number;
  failedRecords: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  resultSummary: RecalcResultSummary | null;
}

/**
 * 睡眠记录
 */
interface SleepRecord {
  id: string;
  deviceId: string;
  date: string;
  algorithmVersion: string;
  sleepScore: number;
  rawData?: unknown;
}

/**
 * 重算结果
 */
interface RecalcResult {
  recordId: string;
  deviceId: string;
  date: string;
  previousAlgorithmVersion: string;
  newAlgorithmVersion: string;
  previousSleepScore: number;
  newSleepScore: number;
  sleepStageChanges: Array<{ stage: string; previousDuration: number; newDuration: number }>;
  recalculatedAt: string;
}

/**
 * 重算结果摘要
 */
interface RecalcResultSummary {
  totalRecords: number;
  changedRecords: number;
  unchangedRecords: number;
  averageScoreDiff: number;
  maxScoreDiff: number;
  algorithmVersion: string;
  previousAlgorithmVersion?: string;
  dateRange: { start: string; end: string };
}
