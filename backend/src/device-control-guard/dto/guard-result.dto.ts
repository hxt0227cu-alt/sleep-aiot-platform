import { CommandRiskLevel } from './guard-command.dto';

/**
 * 校验结果状态
 */
export enum GuardResultStatus {
  /** 通过，允许执行 */
  ALLOWED = 'ALLOWED',
  /** 需要二次确认 */
  REQUIRE_CONFIRMATION = 'REQUIRE_CONFIRMATION',
  /** 被拒绝 */
  DENIED = 'DENIED',
}

/**
 * 拒绝原因代码
 */
export enum GuardDenialReason {
  COMMAND_NOT_IN_WHITELIST = 'COMMAND_NOT_IN_WHITELIST',
  PARAM_OUT_OF_RANGE = 'PARAM_OUT_OF_RANGE',
  PARAM_NOT_ALLOWED = 'PARAM_NOT_ALLOWED',
  DEVICE_OFFLINE = 'DEVICE_OFFLINE',
  DEVICE_STATE_CONFLICT = 'DEVICE_STATE_CONFLICT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED',
  CONFIRMATION_INVALID = 'CONFIRMATION_INVALID',
  TENANT_QUOTA_EXCEEDED = 'TENANT_QUOTA_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * 安全校验结果 DTO
 */
export class GuardResultDto {
  /** 校验状态 */
  status: GuardResultStatus;

  /** 评估出的风险等级 */
  riskLevel: CommandRiskLevel;

  /** 拒绝原因（status=DENIED 时必填） */
  denialReason?: GuardDenialReason;

  /** 拒绝详情描述 */
  denialMessage?: string;

  /** 二次确认 Token（status=REQUIRE_CONFIRMATION 时返回） */
  confirmationToken?: string;

  /** 二次确认过期时间（ISO 8601） */
  confirmationExpiresAt?: string;

  /** 校验通过的指令摘要 */
  commandSummary?: {
    command: string;
    deviceId: string;
    allowedParams: string[];
  };

  /** 校验耗时（毫秒） */
  guardLatencyMs: number;

  /** 审计记录 ID */
  auditRecordId?: string;

  /** TraceId */
  traceId?: string;
}
