import { Injectable, Logger } from '@nestjs/common';
import { AuditRecorderService } from '../unified-audit/audit-recorder.service';

/**
 * 密钥访问审计服务
 *
 * 记录所有密钥访问操作与调用方；
 * 审计数据写入统一审计底座。
 */
@Injectable()
export class AccessAuditService {
  private readonly logger = new Logger(AccessAuditService.name);

  constructor(private readonly auditRecorder: AuditRecorderService) {}

  /**
   * 记录密钥访问
   *
   * @param secretPath 密钥路径
   * @param operation 操作类型：read / write / delete / rotate / rollback / cache_hit
   * @param operatorId 操作人
   * @param details 附加详情
   */
  async recordAccess(
    secretPath: string,
    operation: SecretAccessOperation,
    operatorId: string,
    details?: string,
  ): Promise<void> {
    try {
      await this.auditRecorder.record({
        eventType: 'vault_secret_access',
        action: operation,
        resourceType: 'secret',
        resourceId: secretPath,
        operatorId,
        result: operation === 'rotate_failed' ? 'failed' : 'success',
        metadata: {
          secretPath,
          operation,
          details,
          timestamp: new Date().toISOString(),
        },
      });

      this.logger.debug(`密钥访问审计: path=${secretPath}, op=${operation}, operator=${operatorId}`);
    } catch (error) {
      // 审计失败不阻断主流程
      this.logger.error(`密钥访问审计记录失败: ${error.message}`);
    }
  }

  /**
   * 查询密钥访问日志
   */
  async queryAccessLogs(filter: {
    secretPath?: string;
    operation?: SecretAccessOperation;
    operatorId?: string;
    startTime?: string;
    endTime?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ records: SecretAccessRecord[]; total: number }> {
    const result = await this.auditRecorder.query({
      eventType: 'vault_secret_access',
      resourceId: filter.secretPath,
      operatorId: filter.operatorId,
      startTime: filter.startTime,
      endTime: filter.endTime,
      page: filter.page,
      pageSize: filter.pageSize,
    });

    return {
      records: result.records.map((r) => ({
        secretPath: r.resourceId,
        operation: r.action as SecretAccessOperation,
        operatorId: r.operatorId || '',
        timestamp: r.timestamp || '',
        result: r.result,
        details: r.metadata?.details as string | undefined,
      })),
      total: result.total,
    };
  }

  /**
   * 导出密钥访问日志（合规审计）
   */
  async exportAccessLogs(filter: {
    startTime: string;
    endTime: string;
    secretPath?: string;
  }): Promise<string> {
    const { records } = await this.queryAccessLogs({
      ...filter,
      page: 1,
      pageSize: 10000,
    });

    const headers = ['timestamp', 'secretPath', 'operation', 'operatorId', 'result', 'details'];
    const rows = records.map((r) => [
      r.timestamp,
      r.secretPath,
      r.operation,
      r.operatorId,
      r.result,
      r.details || '',
    ]);

    return [headers.join(','), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  }

  /**
   * 检测异常访问模式
   */
  async detectAnomalousAccess(): Promise<AnomalousAccessAlert[]> {
    // 实际实现应分析访问日志，检测：
    // - 非工作时间访问
    // - 高频访问
    // - 未授权路径访问
    // - 新用户首次访问敏感密钥
    this.logger.debug('检测异常密钥访问模式');
    return [];
  }
}

/**
 * 密钥访问操作类型
 */
export type SecretAccessOperation =
  | 'read'
  | 'write'
  | 'delete'
  | 'rotate'
  | 'rotate_failed'
  | 'rollback'
  | 'cache_hit'
  | 'success'
  | 'not_found'
  | 'error';

/**
 * 密钥访问记录
 */
export interface SecretAccessRecord {
  secretPath: string;
  operation: SecretAccessOperation;
  operatorId: string;
  timestamp: string;
  result: string;
  details?: string;
}

/**
 * 异常访问告警
 */
export interface AnomalousAccessAlert {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  secretPath: string;
  operatorId: string;
  description: string;
  timestamp: string;
}
