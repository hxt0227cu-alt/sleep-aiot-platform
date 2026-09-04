import { Injectable, Logger } from '@nestjs/common';

/**
 * 熔断服务
 *
 * 第三方依赖故障时自动熔断，执行降级策略。
 *
 * 实现经典的熔断器模式：
 * - CLOSED：正常状态，请求通过
 * - OPEN：熔断状态，请求直接失败，执行降级
 * - HALF_OPEN：半开状态，允许少量请求探测依赖是否恢复
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  /** 熔断器状态存储 */
  private breakers: Map<string, CircuitBreakerState> = new Map();

  /** 默认熔断配置 */
  private readonly DEFAULT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: 5, // 连续失败 5 次触发熔断
    successThreshold: 3, // 半开状态连续成功 3 次恢复
    timeoutMs: 30000, // 熔断持续时间 30 秒
    halfOpenMaxRequests: 3, // 半开状态最大请求数
  };

  /**
   * 执行带熔断保护的调用
   *
   * @param name 熔断器名称（如 'llm-api'、'baidu-voice'）
   * @param action 实际执行的操作
   * @param fallback 降级操作
   * @returns 操作结果或降级结果
   */
  async execute<T>(
    name: string,
    action: () => Promise<T>,
    fallback?: () => Promise<T> | T,
  ): Promise<T> {
    const breaker = this.getOrCreateBreaker(name);

    // 检查熔断器状态
    if (breaker.state === 'OPEN') {
      if (Date.now() >= breaker.openedAt + breaker.config.timeoutMs) {
        // 进入半开状态
        breaker.state = 'HALF_OPEN';
        breaker.halfOpenRequests = 0;
        breaker.halfOpenSuccesses = 0;
        this.logger.log(`熔断器 ${name} 进入半开状态`);
      } else {
        // 熔断中，执行降级
        this.logger.warn(`熔断器 ${name} 处于开启状态，执行降级`);
        if (fallback) return fallback();
        throw new CircuitBreakerOpenError(
          name,
          breaker.openedAt + breaker.config.timeoutMs - Date.now(),
        );
      }
    }

    // 半开状态限制请求数
    if (
      breaker.state === 'HALF_OPEN' &&
      breaker.halfOpenRequests >= breaker.config.halfOpenMaxRequests
    ) {
      this.logger.warn(`熔断器 ${name} 半开状态请求数已满，执行降级`);
      if (fallback) return fallback();
      throw new CircuitBreakerOpenError(name, 5000);
    }

    if (breaker.state === 'HALF_OPEN') {
      breaker.halfOpenRequests++;
    }

    try {
      const result = await action();
      this.recordSuccess(name, breaker);
      return result;
    } catch (error) {
      this.recordFailure(name, breaker, error);
      if (fallback) {
        this.logger.warn(`熔断器 ${name} 调用失败，执行降级: ${error.message}`);
        return fallback();
      }
      throw error;
    }
  }

  /**
   * 记录成功
   */
  private recordSuccess(name: string, breaker: CircuitBreakerState): void {
    breaker.consecutiveFailures = 0;

    if (breaker.state === 'HALF_OPEN') {
      breaker.halfOpenSuccesses++;
      if (breaker.halfOpenSuccesses >= breaker.config.successThreshold) {
        breaker.state = 'CLOSED';
        breaker.halfOpenRequests = 0;
        breaker.halfOpenSuccesses = 0;
        this.logger.log(`熔断器 ${name} 恢复关闭状态`);
      }
    }
  }

  /**
   * 记录失败
   */
  private recordFailure(
    name: string,
    breaker: CircuitBreakerState,
    error: Error,
  ): void {
    breaker.consecutiveFailures++;
    breaker.lastFailure = error.message;
    breaker.lastFailureTime = Date.now();

    if (breaker.state === 'HALF_OPEN') {
      // 半开状态失败，重新进入熔断
      breaker.state = 'OPEN';
      breaker.openedAt = Date.now();
      breaker.halfOpenRequests = 0;
      breaker.halfOpenSuccesses = 0;
      this.logger.warn(
        `熔断器 ${name} 半开状态失败，重新熔断: ${error.message}`,
      );
      return;
    }

    if (breaker.consecutiveFailures >= breaker.config.failureThreshold) {
      breaker.state = 'OPEN';
      breaker.openedAt = Date.now();
      this.logger.error(
        `熔断器 ${name} 触发熔断: 连续失败 ${breaker.consecutiveFailures} 次, 最后错误: ${error.message}`,
      );
    }
  }

  /**
   * 获取或创建熔断器
   */
  private getOrCreateBreaker(name: string): CircuitBreakerState {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, {
        name,
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        halfOpenRequests: 0,
        halfOpenSuccesses: 0,
        lastFailure: null,
        lastFailureTime: null,
        config: { ...this.DEFAULT_CONFIG },
      });
    }
    return this.breakers.get(name)!;
  }

  /**
   * 获取熔断器状态
   */
  getBreakerStatus(name: string): CircuitBreakerStatus | null {
    const breaker = this.breakers.get(name);
    if (!breaker) return null;

    return {
      name: breaker.name,
      state: breaker.state,
      consecutiveFailures: breaker.consecutiveFailures,
      openedAt: breaker.openedAt
        ? new Date(breaker.openedAt).toISOString()
        : null,
      lastFailure: breaker.lastFailure,
      lastFailureTime: breaker.lastFailureTime
        ? new Date(breaker.lastFailureTime).toISOString()
        : null,
      config: breaker.config,
    };
  }

  /**
   * 列出所有熔断器状态
   */
  listAllBreakers(): CircuitBreakerStatus[] {
    return Array.from(this.breakers.keys())
      .map((name) => this.getBreakerStatus(name))
      .filter((b): b is CircuitBreakerStatus => b !== null);
  }

  /**
   * 手动重置熔断器
   */
  resetBreaker(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.state = 'CLOSED';
      breaker.consecutiveFailures = 0;
      breaker.openedAt = 0;
      breaker.halfOpenRequests = 0;
      breaker.halfOpenSuccesses = 0;
      this.logger.log(`熔断器 ${name} 已手动重置`);
    }
  }

  /**
   * 配置熔断器
   */
  configureBreaker(name: string, config: Partial<CircuitBreakerConfig>): void {
    const breaker = this.getOrCreateBreaker(name);
    breaker.config = { ...breaker.config, ...config };
    this.logger.log(`熔断器 ${name} 配置已更新`);
  }
}

/**
 * 熔断器状态
 */
type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * 熔断器配置
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
  halfOpenMaxRequests: number;
}

/**
 * 熔断器内部状态
 */
interface CircuitBreakerState {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenRequests: number;
  halfOpenSuccesses: number;
  lastFailure: string | null;
  lastFailureTime: number | null;
  config: CircuitBreakerConfig;
}

/**
 * 熔断器状态（对外）
 */
export interface CircuitBreakerStatus {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: string | null;
  lastFailure: string | null;
  lastFailureTime: string | null;
  config: CircuitBreakerConfig;
}

/**
 * 熔断器开启错误
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit breaker '${breakerName}' is open, retry after ${retryAfterMs}ms`,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}
