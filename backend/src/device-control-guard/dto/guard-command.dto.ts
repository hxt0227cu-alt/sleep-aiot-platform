import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';

/**
 * 指令风险等级
 * - LOW: 低风险，只读或状态查询
 * - MEDIUM: 中风险，常规设备控制（灯光、音量等）
 * - HIGH: 高风险，影响设备安全或用户健康（OTA、工厂重置、报警阈值修改）
 * - CRITICAL: 极高风险，不可逆操作（证书吊销、密钥销毁、设备解绑）
 */
export enum CommandRiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * 安全校验指令 DTO
 */
export class GuardCommandDto {
  /** 设备唯一标识 */
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  /** 指令类型，必须在白名单内 */
  @IsString()
  @IsNotEmpty()
  command: string;

  /** 指令参数 */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  /** 指令来源：app / api / ai / system */
  @IsString()
  @IsOptional()
  source?: string;

  /** 操作用户 ID */
  @IsString()
  @IsOptional()
  userId?: string;

  /** 租户 ID */
  @IsString()
  @IsOptional()
  tenantId?: string;

  /** 风险等级（由安全闸评估后填充） */
  @IsOptional()
  @IsEnum(CommandRiskLevel)
  riskLevel?: CommandRiskLevel;

  /** 二次确认 Token，高风险指令必须携带 */
  @IsString()
  @IsOptional()
  confirmationToken?: string;

  /** 请求 TraceId */
  @IsString()
  @IsOptional()
  traceId?: string;
}

/**
 * 指令白名单条目
 */
export interface CommandWhitelistEntry {
  command: string;
  riskLevel: CommandRiskLevel;
  allowedParams: string[];
  paramConstraints: Record<
    string,
    { min?: number; max?: number; enum?: string[]; type: string }
  >;
  requiresConfirmation: boolean;
  rateLimitPerMinute: number;
  description: string;
}
