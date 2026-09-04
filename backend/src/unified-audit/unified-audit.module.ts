import { Module, Global } from '@nestjs/common';
import { AuditRecorderService } from './audit-recorder.service';
import { AuditQueryService } from './audit-query.service';
import { AuditExportService } from './audit-export.service';

/**
 * 统一审计模块
 *
 * 提供统一的审计写入、查询、导出接口，
 * 支持多类型审计事件，包含操作人、时间、对象、结果、来源等标准字段。
 *
 * 全局模块，所有业务模块均可直接注入使用。
 */
@Global()
@Module({
  providers: [AuditRecorderService, AuditQueryService, AuditExportService],
  exports: [AuditRecorderService, AuditQueryService, AuditExportService],
})
export class UnifiedAuditModule {}
