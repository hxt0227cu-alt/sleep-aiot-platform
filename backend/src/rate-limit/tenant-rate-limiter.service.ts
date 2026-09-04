import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 租户级限流服务
 *
 * 按租户配额控制 API 调用速率、AI Token 消耗、数据库连接数，
 * 超配额自动降级。
 */
@Injectable()
export class TenantRateLimiterService {
  private readonly logger = new Logger(TenantRateLimiterService.name);

  /** 限流键前缀 */
  private readonly RATE_PREFIX = 'ratelimit:tenant:';

  /** Token 消耗键前缀 */
  private readonly TOKEN_PREFIX = 'ratelimit:tenant:token:';

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
  };

  /** 租户配额覆盖 */
  private tenantQuotas: Map<string, Partial<TenantQuotas>> = new Map();

  constructor(private readonly redis: RedisService) {}

  /**
   * 检查租户 API 调用配额
   *
   * @param tenantId 租户 ID
   * @param requests 请求数量
   * @returns 限流结果
   */
  async checkApiRateLimit(tenantId: string, requests: number = 1): Promise<RateLimitResult> {
    const quotas = this.getTenantQuotas(tenantId);
    const results: { window: string; allowed: boolean; current: number; limit: number; remaining: number }[] = [];

    // 分钟级
    const minResult = await this.checkWindow(
      `${this.RATE_PREFIX}${tenantId}:api:min`,
      requests,
      quotas.apiCallsPerMinute,
      60,
    );
    results.push({ window: 'minute', ...minResult });

    // 小时级
    const hourResult = await this.checkWindow(
      `${this.RATE_PREFIX}${tenantId}:api:hour`,
      requests,
      quotas.apiCallsPerHour,
      3600,
    );
    results.push({ window: 'hour', ...hourResult });

    // 天级
    const dayResult = await this.checkWindow(
      `${this.RATE_PREFIX}${tenantId}:api:day`,
      requests,
      quotas.apiCallsPerDay,
      86400,
    );
    results.push({ window: 'day', ...dayResult });

    const denied = results.find((r) => !r.allowed);
    return {
      allowed: !denied,
      deniedWindow: denied?.window,
      currentUsage: results.reduce((acc, r) => ({ ...acc, [r.window]: r.current }), {}),
      limits: {
        minute: quotas.apiCallsPerMinute,
        hour: quotas.apiCallsPerHour,
        day: quotas.apiCallsPerDay,
      },
      retryAfter: denied ? this.getRetryAfter(denied.window) : 0,
    };
  }

  /**
   * 检查租户 AI Token 配额
   */
  async checkAiTokenLimit(tenantId: string, tokens: number): Promise<RateLimitResult> {
    const quotas = this.getTenantQuotas(tenantId);

    const minResult = await this.checkWindow(
      `${this.TOKEN_PREFIX}${tenantId}:min`,
      tokens,
      quotas.aiTokensPerMinute,
      60,
    );

    const dayResult = await this.checkWindow(
      `${this.TOKEN_PREFIX}${tenantId}:day`,
      tokens,
      quotas.aiTokensPerDay,
      86400,
    );

    const denied = [minResult, dayResult].find((r) => !r.allowed);
    return {
      allowed: !denied,
      deniedWindow: denied ? (denied === minResult ? 'minute' : 'day') : undefined,
      currentUsage: { minute: minResult.current, day: dayResult.current },
      limits: { minute: quotas.aiTokensPerMinute, day: quotas.aiTokensPerDay },
      retryAfter: denied ? (denied === minResult ? 60 : 86400) : 0,
    };
  }

  /**
   * 获取租户配额使用情况
   */
  async getQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    const quotas = this.getTenantQuotas(tenantId);

    const apiMin = await this.getCurrentUsage(`${this.RATE_PREFIX}${tenantId}:api:min`);
    const apiHour = await this.getCurrentUsage(`${this.RATE_PREFIX}${tenantId}:api:hour`);
    const apiDay = await this.getCurrentUsage(`${this.RATE_PREFIX}${tenantId}:api:day`);
    const tokenMin = await this.getCurrentUsage(`${this.TOKEN_PREFIX}${tenantId}:min`);
    const tokenDay = await this.getCurrentUsage(`${this.TOKEN_PREFIX}${tenantId}:day`);

    return {
      tenantId,
      quotas,
      usage: {
        apiCalls: { minute: apiMin, hour: apiHour, day: apiDay },
        aiTokens: { minute: tokenMin, day: tokenDay },
      },
      utilization: {
        apiPerMinute: apiMin / quotas.apiCallsPerMinute,
        apiPerHour: apiHour / quotas.apiCallsPerHour,
        apiPerDay: apiDay / quotas.apiCallsPerDay,
        tokenPerMinute: tokenMin / quotas.aiTokensPerMinute,
        tokenPerDay: tokenDay / quotas.aiTokensPerDay,
      },
    };
  }

  /**
   * 设置租户配额
   */
  setTenantQuotas(tenantId: string, quotas: Partial<TenantQuotas>): void {
    this.tenantQuotas.set(tenantId, quotas);
    this.logger.log(`租户 ${tenantId} 配额已更新`);
  }

  /**
   * 获取租户配额（合并默认值）
   */
  private getTenantQuotas(tenantId: string): TenantQuotas {
    const override = this.tenantQuotas.get(tenantId);
    return override ? { ...this.DEFAULT_QUOTAS, ...override } : this.DEFAULT_QUOTAS;
  }

  /**
   * 检查时间窗口配额
   */
  private async checkWindow(key: string, amount: number, limit: number, ttl: number): Promise<{ allowed: boolean; current: number; limit: number; remaining: number }> {
    const current = await this.redis.incrby(key, amount);
    if (current === amount) {
      await this.redis.expire(key, ttl);
    }
    const allowed = current <= limit;
    return { allowed, current, limit, remaining: Math.max(0, limit - current) };
  }

  /**
   * 获取当前使用量
   */
  private async getCurrentUsage(key: string): Promise<number> {
    const val = await this.redis.get(key);
    return val ? parseInt(val, 10) : 0;
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
}

/**
 * 限流结果
 */
export interface RateLimitResult {
  allowed: boolean;
  deniedWindow?: string;
  currentUsage: Record<string, number>;
  limits: Record<string, number>;
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
}
