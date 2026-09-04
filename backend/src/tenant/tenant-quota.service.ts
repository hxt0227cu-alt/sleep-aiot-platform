import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 租户配额服务
 *
 * 管理租户的 API 调用速率、数据库连接数、存储容量、AI Token 预算，
 * 实时监控与超支熔断。
 */
@Injectable()
export class TenantQuotaService {
  private readonly logger = new Logger(TenantQuotaService.name);

  /** 配额键前缀 */
  private readonly QUOTA_PREFIX = 'quota:tenant:';

  /** 使用量键前缀 */
  private readonly USAGE_PREFIX = 'usage:tenant:';

  /** 默认租户配额 */
  private readonly DEFAULT_QUOTAS: TenantQuotas = {
    apiCallsPerMinute: 1000,
    apiCallsPerHour: 30000,
    apiCallsPerDay: 500000,
    aiTokensPerMinute: 100000,
    aiTokensPerDay: 10000000,
    maxDbConnections: 20,
    maxConcurrentRequests: 50,
    storageGb: 100,
    maxDevices: 100,
    maxUsers: 50,
  };

  /** 租户配额覆盖 */
  private tenantQuotas: Map<string, Partial<TenantQuotas>> = new Map();

  constructor(private readonly redis: RedisService) {}

  /**
   * 获取租户配额
   */
  getTenantQuotas(tenantId: string): TenantQuotas {
    const override = this.tenantQuotas.get(tenantId);
    return override ? { ...this.DEFAULT_QUOTAS, ...override } : { ...this.DEFAULT_QUOTAS };
  }

  /**
   * 设置租户配额
   */
  setTenantQuotas(tenantId: string, quotas: Partial<TenantQuotas>): void {
    this.tenantQuotas.set(tenantId, quotas);
    this.logger.log(`租户 ${tenantId} 配额已更新`);
  }

  /**
   * 检查并记录 API 调用
   */
  async checkAndRecordApiCall(tenantId: string, calls: number = 1): Promise<QuotaCheckResult> {
    const quotas = this.getTenantQuotas(tenantId);
    const results: { window: string; allowed: boolean; current: number; limit: number }[] = [];

    // 分钟级
    const minKey = `${this.USAGE_PREFIX}${tenantId}:api:min`;
    const minCurrent = await this.redis.incrby(minKey, calls);
    if (minCurrent === calls) {
      await this.redis.expire(minKey, 60);
    }
    results.push({ window: 'minute', allowed: minCurrent <= quotas.apiCallsPerMinute, current: minCurrent, limit: quotas.apiCallsPerMinute });

    // 小时级
    const hourKey = `${this.USAGE_PREFIX}${tenantId}:api:hour`;
    const hourCurrent = await this.redis.incrby(hourKey, calls);
    if (hourCurrent === calls) {
      await this.redis.expire(hourKey, 3600);
    }
    results.push({ window: 'hour', allowed: hourCurrent <= quotas.apiCallsPerHour, current: hourCurrent, limit: quotas.apiCallsPerHour });

    // 天级
    const dayKey = `${this.USAGE_PREFIX}${tenantId}:api:day`;
    const dayCurrent = await this.redis.incrby(dayKey, calls);
    if (dayCurrent === calls) {
      await this.redis.expire(dayKey, 86400);
    }
    results.push({ window: 'day', allowed: dayCurrent <= quotas.apiCallsPerDay, current: dayCurrent, limit: quotas.apiCallsPerDay });

    const denied = results.find((r) => !r.allowed);
    return {
      allowed: !denied,
      deniedWindow: denied?.window,
      usage: results.reduce((acc, r) => ({ ...acc, [r.window]: { current: r.current, limit: r.limit } }), {}),
      retryAfter: denied ? this.getRetryAfter(denied.window) : 0,
    };
  }

  /**
   * 检查 AI Token 配额
   */
  async checkAiTokenQuota(tenantId: string, tokens: number): Promise<QuotaCheckResult> {
    const quotas = this.getTenantQuotas(tenantId);

    const minKey = `${this.USAGE_PREFIX}${tenantId}:ai-token:min`;
    const minCurrent = await this.redis.incrby(minKey, tokens);
    if (minCurrent === tokens) {
      await this.redis.expire(minKey, 60);
    }

    const dayKey = `${this.USAGE_PREFIX}${tenantId}:ai-token:day`;
    const dayCurrent = await this.redis.incrby(dayKey, tokens);
    if (dayCurrent === tokens) {
      await this.redis.expire(dayKey, 86400);
    }

    const minuteAllowed = minCurrent <= quotas.aiTokensPerMinute;
    const dayAllowed = dayCurrent <= quotas.aiTokensPerDay;

    return {
      allowed: minuteAllowed && dayAllowed,
      deniedWindow: !minuteAllowed ? 'minute' : !dayAllowed ? 'day' : undefined,
      usage: {
        minute: { current: minCurrent, limit: quotas.aiTokensPerMinute },
        day: { current: dayCurrent, limit: quotas.aiTokensPerDay },
      },
      retryAfter: !minuteAllowed ? 60 : !dayAllowed ? 86400 : 0,
    };
  }

  /**
   * 获取租户配额使用情况
   */
  async getQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    const quotas = this.getTenantQuotas(tenantId);

    const [apiMin, apiHour, apiDay, tokenMin, tokenDay] = await Promise.all([
      this.redis.get(`${this.USAGE_PREFIX}${tenantId}:api:min`),
      this.redis.get(`${this.USAGE_PREFIX}${tenantId}:api:hour`),
      this.redis.get(`${this.USAGE_PREFIX}${tenantId}:api:day`),
      this.redis.get(`${this.USAGE_PREFIX}${tenantId}:ai-token:min`),
      this.redis.get(`${this.USAGE_PREFIX}${tenantId}:ai-token:day`),
    ]);

    const usage = {
      apiCalls: {
        minute: parseInt(apiMin || '0', 10),
        hour: parseInt(apiHour || '0', 10),
        day: parseInt(apiDay || '0', 10),
      },
      aiTokens: {
        minute: parseInt(tokenMin || '0', 10),
        day: parseInt(tokenDay || '0', 10),
      },
    };

    return {
      tenantId,
      quotas,
      usage,
      utilization: {
        apiPerMinute: quotas.apiCallsPerMinute > 0 ? usage.apiCalls.minute / quotas.apiCallsPerMinute : 0,
        apiPerHour: quotas.apiCallsPerHour > 0 ? usage.apiCalls.hour / quotas.apiCallsPerHour : 0,
        apiPerDay: quotas.apiCallsPerDay > 0 ? usage.apiCalls.day / quotas.apiCallsPerDay : 0,
        tokenPerMinute: quotas.aiTokensPerMinute > 0 ? usage.aiTokens.minute / quotas.aiTokensPerMinute : 0,
        tokenPerDay: quotas.aiTokensPerDay > 0 ? usage.aiTokens.day / quotas.aiTokensPerDay : 0,
      },
      alerts: this.checkQuotaAlerts(usage, quotas),
    };
  }

  /**
   * 检查配额告警
   */
  private checkQuotaAlerts(usage: { apiCalls: { minute: number; hour: number; day: number }; aiTokens: { minute: number; day: number } }, quotas: TenantQuotas): QuotaAlert[] {
    const alerts: QuotaAlert[] = [];
    const threshold = 0.8; // 80% 告警

    if (usage.apiCalls.minute / quotas.apiCallsPerMinute >= threshold) {
      alerts.push({ type: 'api_minute', level: 'warning', message: `API 分钟调用量已达 ${(usage.apiCalls.minute / quotas.apiCallsPerMinute * 100).toFixed(1)}%` });
    }
    if (usage.apiCalls.day / quotas.apiCallsPerDay >= threshold) {
      alerts.push({ type: 'api_day', level: 'warning', message: `API 日调用量已达 ${(usage.apiCalls.day / quotas.apiCallsPerDay * 100).toFixed(1)}%` });
    }
    if (usage.aiTokens.day / quotas.aiTokensPerDay >= threshold) {
      alerts.push({ type: 'ai_token_day', level: 'warning', message: `AI Token 日用量已达 ${(usage.aiTokens.day / quotas.aiTokensPerDay * 100).toFixed(1)}%` });
    }

    return alerts;
  }

  /**
   * 重置租户使用量（用于新计费周期）
   */
  async resetTenantUsage(tenantId: string): Promise<void> {
    const keys = [
      `${this.USAGE_PREFIX}${tenantId}:api:min`,
      `${this.USAGE_PREFIX}${tenantId}:api:hour`,
      `${this.USAGE_PREFIX}${tenantId}:api:day`,
      `${this.USAGE_PREFIX}${tenantId}:ai-token:min`,
      `${this.USAGE_PREFIX}${tenantId}:ai-token:day`,
    ];
    await this.redis.del(...keys);
    this.logger.log(`租户 ${tenantId} 使用量已重置`);
  }

  /**
   * 获取重试等待时间
   */
  private getRetryAfter(window: string): number {
    switch (window) {
      case 'minute': return 60;
      case 'hour': return 3600;
      case 'day': return 86400;
      default: return 60;
    }
  }
}

/**
 * 租户配额
 */
export interface TenantQuotas {
  apiCallsPerMinute: number;
  apiCallsPerHour: number;
  apiCallsPerDay: number;
  aiTokensPerMinute: number;
  aiTokensPerDay: number;
  maxDbConnections: number;
  maxConcurrentRequests: number;
  storageGb: number;
  maxDevices: number;
  maxUsers: number;
}

/**
 * 配额检查结果
 */
export interface QuotaCheckResult {
  allowed: boolean;
  deniedWindow?: string;
  usage: Record<string, { current: number; limit: number }>;
  retryAfter: number;
}

/**
 * 租户配额使用情况
 */
export interface TenantQuotaUsage {
  tenantId: string;
  quotas: TenantQuotas;
  usage: {
    apiCalls: { minute: number; hour: number; day: number };
    aiTokens: { minute: number; day: number };
  };
  utilization: {
    apiPerMinute: number;
    apiPerHour: number;
    apiPerDay: number;
    tokenPerMinute: number;
    tokenPerDay: number;
  };
  alerts: QuotaAlert[];
}

/**
 * 配额告警
 */
interface QuotaAlert {
  type: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
}
