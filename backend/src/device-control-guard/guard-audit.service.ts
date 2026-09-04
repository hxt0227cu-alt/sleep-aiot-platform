import { Injectable, Logger } from '@nestjs/common';
import { CommandRiskLevel } from './dto/guard-command.dto';
import { GuardResultStatus, GuardDenialReason } from './dto/guard-result.dto';
import { AuditRecorderService } from '../unified-audit/audit-recorder.service';

/**
 * 安全闸审计服务
 *
 * 记录所有指令的校验结果、拦截原因、操作人；
 * 审计数据写入统一审计底座。
 */
@Injectable()
export class GuardAuditService {
  private readonly logger = new Logger(GuardAuditService.name);

  constructor(private readonly auditRecorder: AuditRecorderService) {}

  /**
   * 记录安全闸审计事件
   */
  async record(entry: GuardAuditEntry): Promise<string> {
    try {
      const auditRecord = await this.auditRecorder.record({
        eventType: 'device_control_guard',
        action: entry.command,
        resourceType: 'device',
        resourceId: entry.deviceId,
        operatorId: entry.userId,
        tenantId: entry.tenantId,
        result: entry.result === GuardResultStatus.ALLOWED ? 'success' : 'denied',
        metadata: {
          source: entry.source,
          riskLevel: entry.riskLevel,
          guardResult: entry.result,
          denialReason: entry.denialReason,
          denialMessage: entry.denialMessage,
          traceId: entry.traceId,
        },
        ipAddress: undefined,
        userAgent: undefined,
      });

      this.logger.debug(
        `安全闸审计记录: device=${entry.deviceId}, command=${entry.command}, result=${entry.result}, risk=${entry.riskLevel}`,
      );

      return auditRecord.id;
    } catch (error) {
      this.logger.error(`安全闸审计记录失败: ${error.message}`, error.stack);
      // 审计失败不阻断主流程，但记录日志
      return `audit-failed-${Date.now()}`;
    }
  }

  /**
   * 批量查询安全闸审计记录
   */
  async query(filter: GuardAuditQuery): Promise<{ records: GuardAuditEntry[]; total: number }> {
    // 委托统一审计服务查询
    const result = await this.auditRecorder.query({
      eventType: 'device_control_guard',
      tenantId: filter.tenantId,
      resourceId: filter.deviceId,
      startTime: filter.startTime,
      endTime: filter.endTime,
      result: filter.result,
      page: filter.page,
      pageSize: filter.pageSize,
    });

    return {
      records: result.records.map((r) => ({
        deviceId: r.resourceId,
        command: r.action,
        source: r.metadata?.source as string | undefined,
        userId: r.operatorId,
        tenantId: r.tenantId,
        riskLevel: r.metadata?.riskLevel as CommandRiskLevel,
        result: r.metadata?.guardResult as GuardResultStatus,
        denialReason: r.metadata?.denialReason as GuardDenialReason | undefined,
        denialMessage: r.metadata?.denialMessage as string | undefined,
        traceId: r.metadata?.traceId as string | undefined,
        timestamp: r.timestamp,
      })),
      total: result.total,
    };
  }

  /**
   * 导出安全闸审计日志（合规场景）
   */
  async exportForCompliance(filter: GuardAuditQuery): Promise<string> {
    const { records } = await this.query(filter);
    const headers = ['timestamp', 'deviceId', 'command', 'source', 'userId', 'riskLevel', 'result', 'denialReason', 'traceId'];
    const rows = records.map((r) => [
      r.timestamp,
      r.deviceId,
      r.command,
      r.source || '',
      r.userId || '',
      r.riskLevel,
      r.result,
      r.denialReason || '',
      r.traceId || '',
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    return csv;
  }
}

/**
 * 安全闸审计条目
 */
export interface GuardAuditEntry {
  deviceId: string;
  command: string;
  source?: string;
  userId?: string;
  tenantId?: string;
  riskLevel: CommandRiskLevel;
  result: GuardResultStatus;
  denialReason?: GuardDenialReason;
  denialMessage?: string;
  traceId?: string;
  timestamp?: string;
}

/**
 * 安全闸审计查询条件
 */
export interface GuardAuditQuery {
  tenantId?: string;
  deviceId?: string;
  startTime?: string;
  endTime?: string;
  result?: GuardResultStatus;
  page?: number;
  pageSize?: number;
}
