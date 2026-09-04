import { Injectable, Logger, LogLevel } from '@nestjs/common';

/**
 * 结构化日志服务
 *
 * 统一日志格式，支持采集到 Loki，实现日志与 Trace 关联。
 *
 * 输出 JSON 格式结构化日志，包含：
 * - timestamp: 时间戳
 * - level: 日志级别
 * - message: 日志消息
 * - traceId: 链路追踪 ID
 * - spanId: 跨度 ID
 * - service: 服务名
 * - environment: 环境
 * - context: 业务上下文
 * - metadata: 附加元数据
 */
@Injectable()
export class StructuredLoggerService {
  private readonly logger = new Logger('StructuredLogger');

  /** 服务名 */
  private readonly serviceName =
    process.env.SERVICE_NAME || 'sleep-platform-backend';

  /** 环境 */
  private readonly environment = process.env.NODE_ENV || 'development';

  /** 当前 TraceId（基于 AsyncLocalStorage 或请求上下文） */
  private currentTraceId: string | null = null;

  /**
   * 记录信息日志
   */
  info(
    message: string,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('info', message, context, metadata);
  }

  /**
   * 记录警告日志
   */
  warn(
    message: string,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('warn', message, context, metadata);
  }

  /**
   * 记录错误日志
   */
  error(
    message: string,
    error?: Error,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    this.log('error', message, context, {
      ...metadata,
      error: error
        ? { name: error.name, message: error.message, stack: error.stack }
        : undefined,
    });
  }

  /**
   * 记录调试日志
   */
  debug(
    message: string,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.environment === 'production') return; // 生产环境不输出 debug
    this.log('debug', message, context, metadata);
  }

  /**
   * 记录详细日志
   */
  verbose(
    message: string,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.environment === 'production') return;
    this.log('verbose', message, context, metadata);
  }

  /**
   * 核心日志方法
   */
  private log(
    level: LogLevel | 'info',
    message: string,
    context?: LogContext,
    metadata?: Record<string, unknown>,
  ): void {
    const logEntry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.serviceName,
      environment: this.environment,
      traceId: context?.traceId || this.currentTraceId,
      spanId: context?.spanId,
      userId: context?.userId,
      tenantId: context?.tenantId,
      deviceId: context?.deviceId,
      requestId: context?.requestId,
      module: context?.module,
      action: context?.action,
      durationMs: context?.durationMs,
      metadata: this.sanitizeMetadata(metadata),
    };

    // 输出 JSON 格式日志
    const logJson = JSON.stringify(logEntry);

    switch (level) {
      case 'error':
        this.logger.error(logJson);
        break;
      case 'warn':
        this.logger.warn(logJson);
        break;
      case 'debug':
        this.logger.debug(logJson);
        break;
      case 'verbose':
        this.logger.verbose(logJson);
        break;
      default:
        this.logger.log(logJson);
    }
  }

  /**
   * 设置当前请求的 TraceId
   */
  setTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }

  /**
   * 清除当前 TraceId
   */
  clearTraceId(): void {
    this.currentTraceId = null;
  }

  /**
   * 生成请求日志（HTTP 请求入口）
   */
  logRequest(
    request: {
      method: string;
      url: string;
      ip?: string;
      headers?: Record<string, string>;
    },
    context?: LogContext,
  ): void {
    this.info('HTTP 请求接收', context, {
      request: {
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers?.['user-agent'],
      },
    });
  }

  /**
   * 生成响应日志（HTTP 请求出口）
   */
  logResponse(
    response: { statusCode: number; durationMs: number },
    context?: LogContext,
  ): void {
    this.info('HTTP 响应发送', context, {
      response: {
        statusCode: response.statusCode,
        durationMs: response.durationMs,
      },
    });
  }

  /**
   * 记录业务事件
   */
  logBusinessEvent(
    eventType: string,
    eventData: Record<string, unknown>,
    context?: LogContext,
  ): void {
    this.info(`业务事件: ${eventType}`, context, {
      eventType,
      eventData,
    });
  }

  /**
   * 记录安全事件
   */
  logSecurityEvent(
    eventType: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details: Record<string, unknown>,
    context?: LogContext,
  ): void {
    const message = `安全事件: ${eventType} (${severity})`;
    if (severity === 'critical' || severity === 'high') {
      this.error(message, undefined, context, {
        securityEvent: eventType,
        severity,
        details,
      });
    } else {
      this.warn(message, context, {
        securityEvent: eventType,
        severity,
        details,
      });
    }
  }

  /**
   * 脱敏元数据（移除敏感信息）
   */
  private sanitizeMetadata(
    metadata?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!metadata) return undefined;

    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = [
      'password',
      'token',
      'secret',
      'key',
      'privateKey',
      'authorization',
      'cookie',
    ];

    for (const [key, value] of Object.entries(metadata)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        sanitized[key] = '[REDACTED]';
      } else if (value instanceof Error) {
        sanitized[key] = { name: value.name, message: value.message };
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

/**
 * 日志上下文
 */
export interface LogContext {
  traceId?: string;
  spanId?: string;
  userId?: string;
  tenantId?: string;
  deviceId?: string;
  requestId?: string;
  module?: string;
  action?: string;
  durationMs?: number;
}

/**
 * 结构化日志条目
 */
interface StructuredLogEntry {
  timestamp: string;
  level: string;
  message: string;
  service: string;
  environment: string;
  traceId?: string | null;
  spanId?: string;
  userId?: string;
  tenantId?: string;
  deviceId?: string;
  requestId?: string;
  module?: string;
  action?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}
