import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 用户级限流服务
 *
 * 防止单用户滥用资源。
 */
@Injectable()
export class UserRateLimiterService {
  private readonly logger = new Logger(UserRateLimiterService.name);

  /** 用户限流键前缀 */
  private readonly PREFIX = 'ratelimit:user:';

  /** 默认用户限流配置 */
  private readonly DEFAULT_LIMITS: UserRateLimits = {
    loginAttemptsPerMinute: 5,
    loginAttemptsPerHour: 20,
    apiCallsPerMinute: 100,
    apiCallsPerHour: 2000,
    aiRequestsPerMinute: 20,
    aiRequestsPerDay: 200,
    deviceCommandsPerMinute: 30,
    passwordResetPerDay: 3,
  };

  constructor(private readonly redis: RedisService) {}

  /**
   * 检查用户登录限流
   */
  async checkLoginLimit(
    userId: string,
    ip?: string,
  ): Promise<{
    allowed: boolean;
    retryAfter: number;
    current: number;
    limit: number;
  }> {
    const key = `${this.PREFIX}${userId}:login:min`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 60);
    }

    const limit = this.DEFAULT_LIMITS.loginAttemptsPerMinute;
    const allowed = current <= limit;

    if (!allowed) {
      this.logger.warn(
        `用户登录限流: user=${userId}, attempts=${current}, ip=${ip}`,
      );
    }

    return { allowed, retryAfter: allowed ? 0 : 60, current, limit };
  }

  /**
   * 检查用户 API 调用限流
   */
  async checkApiLimit(userId: string): Promise<{
    allowed: boolean;
    retryAfter: number;
    current: number;
    limit: number;
  }> {
    const key = `${this.PREFIX}${userId}:api:min`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 60);
    }

    const limit = this.DEFAULT_LIMITS.apiCallsPerMinute;
    return {
      allowed: current <= limit,
      retryAfter: current <= limit ? 0 : 60,
      current,
      limit,
    };
  }

  /**
   * 检查用户 AI 请求限流
   */
  async checkAiRequestLimit(userId: string): Promise<{
    allowed: boolean;
    retryAfter: number;
    current: number;
    limit: number;
  }> {
    const key = `${this.PREFIX}${userId}:ai:min`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 60);
    }

    const limit = this.DEFAULT_LIMITS.aiRequestsPerMinute;
    return {
      allowed: current <= limit,
      retryAfter: current <= limit ? 0 : 60,
      current,
      limit,
    };
  }

  /**
   * 检查用户设备指令限流
   */
  async checkDeviceCommandLimit(userId: string): Promise<{
    allowed: boolean;
    retryAfter: number;
    current: number;
    limit: number;
  }> {
    const key = `${this.PREFIX}${userId}:device:min`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 60);
    }

    const limit = this.DEFAULT_LIMITS.deviceCommandsPerMinute;
    return {
      allowed: current <= limit,
      retryAfter: current <= limit ? 0 : 60,
      current,
      limit,
    };
  }

  /**
   * 检查密码重置限流
   */
  async checkPasswordResetLimit(userId: string): Promise<{
    allowed: boolean;
    retryAfter: number;
    current: number;
    limit: number;
  }> {
    const key = `${this.PREFIX}${userId}:password-reset:day`;
    const current = await this.redis.incr(key);
    if (current === 1) {
      await this.redis.expire(key, 86400);
    }

    const limit = this.DEFAULT_LIMITS.passwordResetPerDay;
    return {
      allowed: current <= limit,
      retryAfter: current <= limit ? 0 : 86400,
      current,
      limit,
    };
  }

  /**
   * 重置用户限流计数（登录成功后调用）
   */
  async resetLoginLimit(userId: string): Promise<void> {
    await this.redis.del(`${this.PREFIX}${userId}:login:min`);
    await this.redis.del(`${this.PREFIX}${userId}:login:hour`);
  }

  /**
   * 获取用户限流状态
   */
  async getUserLimitStatus(userId: string): Promise<UserLimitStatus> {
    const [apiMin, aiMin, deviceMin] = await Promise.all([
      this.redis.get(`${this.PREFIX}${userId}:api:min`),
      this.redis.get(`${this.PREFIX}${userId}:ai:min`),
      this.redis.get(`${this.PREFIX}${userId}:device:min`),
    ]);

    return {
      userId,
      apiCallsPerMinute: {
        current: parseInt(apiMin || '0', 10),
        limit: this.DEFAULT_LIMITS.apiCallsPerMinute,
      },
      aiRequestsPerMinute: {
        current: parseInt(aiMin || '0', 10),
        limit: this.DEFAULT_LIMITS.aiRequestsPerMinute,
      },
      deviceCommandsPerMinute: {
        current: parseInt(deviceMin || '0', 10),
        limit: this.DEFAULT_LIMITS.deviceCommandsPerMinute,
      },
    };
  }
}

/**
 * 用户限流配置
 */
export interface UserRateLimits {
  loginAttemptsPerMinute: number;
  loginAttemptsPerHour: number;
  apiCallsPerMinute: number;
  apiCallsPerHour: number;
  aiRequestsPerMinute: number;
  aiRequestsPerDay: number;
  deviceCommandsPerMinute: number;
  passwordResetPerDay: number;
}

/**
 * 用户限流状态
 */
export interface UserLimitStatus {
  userId: string;
  apiCallsPerMinute: { current: number; limit: number };
  aiRequestsPerMinute: { current: number; limit: number };
  deviceCommandsPerMinute: { current: number; limit: number };
}
