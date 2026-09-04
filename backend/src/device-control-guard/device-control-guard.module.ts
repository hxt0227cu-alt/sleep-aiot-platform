import { Module } from '@nestjs/common';
import { DeviceControlGuardService } from './device-control-guard.service';
import { CommandPolicyService } from './command-policy.service';
import { GuardAuditService } from './guard-audit.service';
import { UnifiedAuditModule } from '../unified-audit/unified-audit.module';
import { TenantModule } from '../tenant/tenant.module';

/**
 * 设备控制安全闸模块
 *
 * 独立于 AI 链路的确定性安全校验单元，对所有设备控制指令
 * （无论来自 LLM、APP 还是 API）执行强制校验：
 * - 指令白名单
 * - 参数范围合法性
 * - 设备状态前置条件
 * - 操作频次限制
 * - 风险等级判定
 *
 * 高风险指令触发用户二次确认。
 */
@Module({
  imports: [UnifiedAuditModule, TenantModule],
  providers: [DeviceControlGuardService, CommandPolicyService, GuardAuditService],
  exports: [DeviceControlGuardService, CommandPolicyService, GuardAuditService],
})
export class DeviceControlGuardModule {}
