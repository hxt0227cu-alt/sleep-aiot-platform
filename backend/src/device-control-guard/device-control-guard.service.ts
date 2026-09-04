import { Injectable, Logger } from '@nestjs/common';
import { GuardCommandDto, CommandRiskLevel } from './dto/guard-command.dto';
import {
  GuardResultDto,
  GuardResultStatus,
  GuardDenialReason,
} from './dto/guard-result.dto';
import { CommandPolicyService } from './command-policy.service';
import { GuardAuditService } from './guard-audit.service';
import { RedisService } from '../redis/redis.service';

/**
 * 安全闸核心服务
 *
 * 对所有设备控制指令（无论来自 LLM、APP 还是 API）执行强制校验：
 * - 指令白名单
 * - 参数范围合法性
 * - 设备状态前置条件
 * - 操作频次限制
 * - 风险等级判定
 *
 * 高风险指令触发用户二次确认。
 */
@Injectable()
export class DeviceControlGuardService {
  private readonly logger = new Logger(DeviceControlGuardService.name);

  /** 二次确认 Token 存储前缀 */
  private readonly CONFIRMATION_PREFIX = 'guard:confirmation:';
  /** 二次确认有效期（秒） */
  private readonly CONFIRMATION_TTL = 300;
  /** 频次限制前缀 */
  private readonly RATE_LIMIT_PREFIX = 'guard:ratelimit:';

  constructor(
    private readonly commandPolicy: CommandPolicyService,
    private readonly guardAudit: GuardAuditService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 执行设备控制指令安全校验
   */
  async validate(command: GuardCommandDto): Promise<GuardResultDto> {
    const startTime = Date.now();
    const traceId = command.traceId || this.generateTraceId();

    this.logger.debug(
      `安全闸校验开始: command=${command.command}, device=${command.deviceId}, traceId=${traceId}`,
    );

    try {
      // 1. 指令白名单校验
      const whitelistEntry = this.commandPolicy.findCommand(
        command.command,
        command.tenantId,
      );
      if (!whitelistEntry) {
        return this.buildDeniedResult(
          command,
          CommandRiskLevel.LOW,
          GuardDenialReason.COMMAND_NOT_IN_WHITELIST,
          `指令 ${command.command} 不在白名单中`,
          startTime,
          traceId,
        );
      }

      // 2. 参数合法性校验
      if (command.params) {
        const paramCheck = this.commandPolicy.validateParams(
          whitelistEntry,
          command.params,
        );
        if (!paramCheck.valid) {
          return this.buildDeniedResult(
            command,
            whitelistEntry.riskLevel,
            GuardDenialReason.PARAM_OUT_OF_RANGE,
            paramCheck.reason || `参数 ${paramCheck.invalidParam} 校验失败`,
            startTime,
            traceId,
          );
        }
      }

      // 3. 频次限制校验
      const rateLimitPassed = await this.checkRateLimit(
        command.deviceId,
        command.command,
        whitelistEntry.rateLimitPerMinute,
      );
      if (!rateLimitPassed) {
        return this.buildDeniedResult(
          command,
          whitelistEntry.riskLevel,
          GuardDenialReason.RATE_LIMIT_EXCEEDED,
          `指令 ${command.command} 调用频次超过限制（${whitelistEntry.rateLimitPerMinute}/分钟）`,
          startTime,
          traceId,
        );
      }

      // 4. 风险等级判定与二次确认
      if (whitelistEntry.requiresConfirmation) {
        if (!command.confirmationToken) {
          // 需要二次确认，生成 Token
          const confirmationToken = this.generateConfirmationToken();
          await this.redis.set(
            `${this.CONFIRMATION_PREFIX}${confirmationToken}`,
            JSON.stringify({
              deviceId: command.deviceId,
              command: command.command,
              params: command.params,
              userId: command.userId,
              tenantId: command.tenantId,
              createdAt: new Date().toISOString(),
            }),
            this.CONFIRMATION_TTL,
          );

          const result: GuardResultDto = {
            status: GuardResultStatus.REQUIRE_CONFIRMATION,
            riskLevel: whitelistEntry.riskLevel,
            confirmationToken,
            confirmationExpiresAt: new Date(
              Date.now() + this.CONFIRMATION_TTL * 1000,
            ).toISOString(),
            commandSummary: {
              command: command.command,
              deviceId: command.deviceId,
              allowedParams: whitelistEntry.allowedParams,
            },
            guardLatencyMs: Date.now() - startTime,
            traceId,
          };

          await this.guardAudit.record({
            deviceId: command.deviceId,
            command: command.command,
            source: command.source,
            userId: command.userId,
            tenantId: command.tenantId,
            riskLevel: whitelistEntry.riskLevel,
            result: GuardResultStatus.REQUIRE_CONFIRMATION,
            traceId,
          });

          return result;
        }

        // 验证二次确认 Token
        const confirmationData = await this.redis.get(
          `${this.CONFIRMATION_PREFIX}${command.confirmationToken}`,
        );
        if (!confirmationData) {
          return this.buildDeniedResult(
            command,
            whitelistEntry.riskLevel,
            GuardDenialReason.CONFIRMATION_INVALID,
            '二次确认 Token 无效或已过期',
            startTime,
            traceId,
          );
        }

        const parsed = JSON.parse(confirmationData);
        if (
          parsed.deviceId !== command.deviceId ||
          parsed.command !== command.command
        ) {
          return this.buildDeniedResult(
            command,
            whitelistEntry.riskLevel,
            GuardDenialReason.CONFIRMATION_INVALID,
            '二次确认 Token 与指令不匹配',
            startTime,
            traceId,
          );
        }

        // 确认通过，删除 Token
        await this.redis.del(
          `${this.CONFIRMATION_PREFIX}${command.confirmationToken}`,
        );
      }

      // 5. 校验通过
      const result: GuardResultDto = {
        status: GuardResultStatus.ALLOWED,
        riskLevel: whitelistEntry.riskLevel,
        commandSummary: {
          command: command.command,
          deviceId: command.deviceId,
          allowedParams: whitelistEntry.allowedParams,
        },
        guardLatencyMs: Date.now() - startTime,
        traceId,
      };

      const auditRecordId = await this.guardAudit.record({
        deviceId: command.deviceId,
        command: command.command,
        source: command.source,
        userId: command.userId,
        tenantId: command.tenantId,
        riskLevel: whitelistEntry.riskLevel,
        result: GuardResultStatus.ALLOWED,
        traceId,
      });
      result.auditRecordId = auditRecordId;

      this.logger.debug(
        `安全闸校验通过: command=${command.command}, risk=${whitelistEntry.riskLevel}, latency=${result.guardLatencyMs}ms`,
      );
      return result;
    } catch (error) {
      this.logger.error(`安全闸校验异常: ${error.message}`, error.stack);
      return this.buildDeniedResult(
        command,
        CommandRiskLevel.HIGH,
        GuardDenialReason.INTERNAL_ERROR,
        '安全闸内部错误，默认拒绝',
        startTime,
        traceId,
      );
    }
  }

  /**
   * 校验频次限制
   */
  private async checkRateLimit(
    deviceId: string,
    command: string,
    limitPerMinute: number,
  ): Promise<boolean> {
    const key = `${this.RATE_LIMIT_PREFIX}${deviceId}:${command}`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 60);
    }
    return current <= limitPerMinute;
  }

  /**
   * 构建拒绝结果
   */
  private buildDeniedResult(
    command: GuardCommandDto,
    riskLevel: CommandRiskLevel,
    reason: GuardDenialReason,
    message: string,
    startTime: number,
    traceId: string,
  ): GuardResultDto {
    const result: GuardResultDto = {
      status: GuardResultStatus.DENIED,
      riskLevel,
      denialReason: reason,
      denialMessage: message,
      guardLatencyMs: Date.now() - startTime,
      traceId,
    };

    this.guardAudit
      .record({
        deviceId: command.deviceId,
        command: command.command,
        source: command.source,
        userId: command.userId,
        tenantId: command.tenantId,
        riskLevel,
        result: GuardResultStatus.DENIED,
        denialReason: reason,
        denialMessage: message,
        traceId,
      })
      .catch((err) => this.logger.error(`审计记录失败: ${err.message}`));

    this.logger.warn(
      `安全闸拒绝: command=${command.command}, reason=${reason}, message=${message}`,
    );
    return result;
  }

  /**
   * 生成 TraceId
   */
  private generateTraceId(): string {
    return `guard-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * 生成二次确认 Token
   */
  private generateConfirmationToken(): string {
    return `confirm-${Date.now()}-${Math.random().toString(36).substring(2, 18)}`;
  }
}
