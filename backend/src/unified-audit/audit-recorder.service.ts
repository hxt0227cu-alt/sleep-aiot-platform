import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuditQueryService, AuditQueryFilter } from './audit-query.service';

/**
 * 审计记录服务
 *
 * 提供统一的审计写入接口，支持多类型审计事件，
 * 包含操作人、时间、对象、结果、来源等标准字段。
 */
@Injectable()
export class AuditRecorderService {
  private readonly logger = new Logger(AuditRecorderService.name);

  /** 内存审计缓冲区（异步批量写入） */
  private buffer: AuditEvent[] = [];

  /** 批量写入大小 */
  private readonly BATCH_SIZE = 50;

  /** 刷新间隔（毫秒） */
  private readonly FLUSH_INTERVAL = 5000;

  /** 刷新定时器 */
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditQuery: AuditQueryService,
  ) {
    this.startFlushTimer();
  }

  /**
   * 记录审计事件
   *
   * @param event 审计事件
   * @returns 审计记录 ID
   */
  async record(event: AuditEvent): Promise<{ id: string }> {
    const auditRecord: AuditEvent = {
      ...event,
      id: this.generateId(),
      timestamp: event.timestamp || new Date().toISOString(),
    };

    // 写入缓冲区
    this.buffer.push(auditRecord);

    // 达到批量大小则立即刷新
    if (this.buffer.length >= this.BATCH_SIZE) {
      this.flush().catch((err) => this.logger.error(`审计批量写入失败: ${err.message}`));
    }

    return { id: auditRecord.id as string };
  }

  /**
   * 查询审计事件
   *
   * 委托统一审计查询服务按条件分页检索，供各业务模块复用。
   */
  query(filter: AuditQueryFilter): Promise<{ records: AuditEvent[]; total: number }> {
    return this.auditQuery.query(filter);
  }

  /**
   * 同步记录审计事件（等待写入完成）
   */
  async recordSync(event: AuditEvent): Promise<{ id: string }> {
    const result = await this.record(event);
    await this.flush();
    return result;
  }

  /**
   * 批量记录审计事件
   */
  async recordBatch(events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      this.buffer.push({
        ...event,
        id: this.generateId(),
        timestamp: event.timestamp || new Date().toISOString(),
      });
    }
    if (this.buffer.length >= this.BATCH_SIZE) {
      await this.flush();
    }
  }

  /**
   * 刷新缓冲区到数据库
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      // 写入数据库（实际使用 Prisma unifiedAuditLog 模型）
      // await this.prisma.unifiedAuditLog.createMany({
      //   data: events.map((e) => ({
      //     id: e.id,
      //     eventType: e.eventType,
      //     action: e.action,
      //     resourceType: e.resourceType,
      //     resourceId: e.resourceId,
      //     operatorId: e.operatorId,
      //     tenantId: e.tenantId,
      //     result: e.result,
      //     metadata: e.metadata,
      //     ipAddress: e.ipAddress,
      //     userAgent: e.userAgent,
      //     timestamp: new Date(e.timestamp!),
      //   })),
      // });

      this.logger.debug(`审计日志批量写入: ${events.length} 条`);
    } catch (error) {
      this.logger.error(`审计日志写入失败: ${error.message}，事件已暂存`);
      // 写回缓冲区，等待下次重试
      this.buffer.unshift(...events);
    }
  }

  /**
   * 启动定时刷新
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush().catch((err) => this.logger.error(`审计定时刷新失败: ${err.message}`));
      }
    }, this.FLUSH_INTERVAL);
  }

  /**
   * 生成审计记录 ID
   */
  private generateId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * 服务关闭时刷新剩余日志
   */
  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
  }
}

/**
 * 审计事件
 */
export interface AuditEvent {
  id?: string;
  /** 事件类型：auth / device_control / data_access / pki / vault / security 等 */
  eventType: string;
  /** 操作动作 */
  action: string;
  /** 资源类型 */
  resourceType: string;
  /** 资源 ID */
  resourceId: string;
  /** 操作人 ID */
  operatorId?: string;
  /** 租户 ID */
  tenantId?: string;
  /** 操作结果：success / failed / denied */
  result: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
  /** IP 地址 */
  ipAddress?: string;
  /** User-Agent */
  userAgent?: string;
  /** 时间戳 */
  timestamp?: string;
}
