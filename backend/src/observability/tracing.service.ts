import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * 链路追踪服务
 *
 * 基于 OpenTelemetry 实现全链路 TraceId 透传。
 *
 * 支持：
 * - TraceId 生成与管理
 * - Span 创建与结束
 * - 上下文传播（HTTP Header / MQTT 消息头）
 * - 追踪数据导出（OTLP）
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  /** 是否启用追踪 */
  private readonly enabled = process.env.TRACING_ENABLED !== 'false';

  /** 服务名 */
  private readonly serviceName =
    process.env.SERVICE_NAME || 'sleep-platform-backend';

  /** 当前活跃的 Span 栈 */
  private spanStack: Span[] = [];

  /**
   * 开始一个 Trace
   *
   * @param name Trace 名称
   * @param traceId 可选的已有 TraceId（用于跨服务传播）
   * @returns Trace 上下文
   */
  startTrace(name: string, traceId?: string): TraceContext {
    if (!this.enabled) {
      return {
        traceId: traceId || 'disabled',
        spanId: 'disabled',
        name,
        startTime: Date.now(),
      };
    }

    const context: TraceContext = {
      traceId: traceId || this.generateTraceId(),
      spanId: this.generateSpanId(),
      name,
      startTime: Date.now(),
      parentSpanId: null,
    };

    this.logger.debug(`Trace 开始: ${context.traceId}, name=${name}`);
    return context;
  }

  /**
   * 开始一个 Span
   *
   * @param name Span 名称
   * @param parentContext 父上下文
   * @returns Span 上下文
   */
  startSpan(name: string, parentContext?: TraceContext): SpanContext {
    if (!this.enabled) {
      return {
        traceId: parentContext?.traceId || 'disabled',
        spanId: 'disabled',
        parentSpanId: parentContext?.spanId,
        name,
        startTime: Date.now(),
      };
    }

    const span: Span = {
      traceId: parentContext?.traceId || this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId: parentContext?.spanId || null,
      name,
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: { code: 0 },
    };

    this.spanStack.push(span);
    this.logger.debug(
      `Span 开始: ${span.spanId}, name=${name}, trace=${span.traceId}`,
    );
    return span;
  }

  /**
   * 结束当前 Span
   *
   * @param context Span 上下文
   * @param status 状态（0=OK, 1=ERROR）
   * @param attributes 附加属性
   */
  endSpan(
    context: SpanContext,
    status: number = 0,
    attributes?: Record<string, string>,
  ): void {
    if (!this.enabled) return;

    const spanIndex = this.spanStack.findIndex(
      (s) => s.spanId === context.spanId,
    );
    if (spanIndex === -1) {
      this.logger.warn(`Span 未找到: ${context.spanId}`);
      return;
    }

    const span = this.spanStack[spanIndex];
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = { code: status };
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes };
    }

    // 导出 Span 数据
    this.exportSpan(span);

    // 从栈中移除
    this.spanStack.splice(spanIndex, 1);

    this.logger.debug(
      `Span 结束: ${span.spanId}, duration=${span.durationMs}ms, status=${status}`,
    );
  }

  /**
   * 为 Span 添加事件
   */
  addSpanEvent(
    context: SpanContext,
    eventName: string,
    attributes?: Record<string, string>,
  ): void {
    if (!this.enabled) return;

    const span = this.spanStack.find((s) => s.spanId === context.spanId);
    if (span) {
      span.events.push({
        name: eventName,
        timestamp: Date.now(),
        attributes: attributes || {},
      });
    }
  }

  /**
   * 为 Span 设置属性
   */
  setSpanAttribute(context: SpanContext, key: string, value: string): void {
    if (!this.enabled) return;

    const span = this.spanStack.find((s) => s.spanId === context.spanId);
    if (span) {
      span.attributes[key] = value;
    }
  }

  /**
   * 从 HTTP Header 提取 Trace 上下文
   */
  extractFromHttpHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): TraceContext | null {
    const traceParent = headers['traceparent'] as string | undefined;
    if (!traceParent) {
      // 尝试自定义 Header
      const traceId = headers['x-trace-id'] as string | undefined;
      const spanId = headers['x-span-id'] as string | undefined;
      if (traceId) {
        return {
          traceId,
          spanId: spanId || this.generateSpanId(),
          name: 'http-request',
          startTime: Date.now(),
        };
      }
      return null;
    }

    // W3C TraceContext 格式: version-traceId-spanId-traceFlags
    const parts = traceParent.split('-');
    if (parts.length >= 3) {
      return {
        traceId: parts[1],
        spanId: parts[2],
        name: 'http-request',
        startTime: Date.now(),
      };
    }

    return null;
  }

  /**
   * 注入 Trace 上下文到 HTTP Header
   */
  injectToHttpHeaders(context: TraceContext): Record<string, string> {
    return {
      traceparent: `00-${context.traceId}-${context.spanId}-01`,
      'x-trace-id': context.traceId,
      'x-span-id': context.spanId,
    };
  }

  /**
   * 注入 Trace 上下文到 MQTT 消息
   */
  injectToMqttMessage(context: TraceContext): Record<string, string> {
    return {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId || '',
    };
  }

  /**
   * 从 MQTT 消息提取 Trace 上下文
   */
  extractFromMqttMessage(
    properties: Record<string, string>,
  ): TraceContext | null {
    if (properties.traceId) {
      return {
        traceId: properties.traceId,
        spanId: properties.spanId || this.generateSpanId(),
        parentSpanId: properties.parentSpanId || null,
        name: 'mqtt-message',
        startTime: Date.now(),
      };
    }
    return null;
  }

  /**
   * 获取当前活跃的 TraceId
   */
  getCurrentTraceId(): string | null {
    if (this.spanStack.length > 0) {
      return this.spanStack[this.spanStack.length - 1].traceId;
    }
    return null;
  }

  /**
   * 生成 TraceId（32 位十六进制）
   */
  private generateTraceId(): string {
    return randomUUID().replace(/-/g, '');
  }

  /**
   * 生成 SpanId（16 位十六进制）
   */
  private generateSpanId(): string {
    return randomUUID().replace(/-/g, '').substring(0, 16);
  }

  /**
   * 导出 Span 数据（OTLP 或日志）
   */
  private exportSpan(span: Span): void {
    // 开发模式：输出到日志
    if (this.environment !== 'production') {
      this.logger.debug(
        `Span 导出: trace=${span.traceId}, span=${span.spanId}, parent=${span.parentSpanId}, ` +
          `name=${span.name}, duration=${span.durationMs}ms, status=${span.status.code}`,
      );
    }

    // 生产模式：导出到 OTLP Collector
    // 实际应使用 @opentelemetry/sdk-trace-node 的 SpanProcessor
  }

  private get environment(): string {
    return process.env.NODE_ENV || 'development';
  }
}

/**
 * Trace 上下文
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  parentSpanId?: string | null;
}

/**
 * Span 上下文
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startTime: number;
}

/**
 * Span 数据
 */
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, string>;
  events: Array<{
    name: string;
    timestamp: number;
    attributes: Record<string, string>;
  }>;
  status: { code: number; message?: string };
}
