import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service';

type RequestWithIdentity = Request & { requestId?: string };

/**
 * HTTP 请求指标采集（ADR-019）。
 *
 * 为什么在 response 的 finish/close 事件上记录，而不是在 RxJS finalize 里：
 *
 * finalize 在**拦截器管道结束时**触发，此时异常过滤器尚未把状态码写进
 * response。结果是所有抛异常的请求都会被记成 status_code="200"，
 * 5xx 序列永远为空 —— 基于错误率的告警看起来配好了，实际永远不会触发。
 * 这类"指标存在但永远正确"的静默失效，比没有指标更危险。
 *
 * finish 事件在响应完全写出后触发，此时 statusCode 已是最终值；
 * close 兜底处理客户端提前断开的情况，避免 activeHttpRequests 只增不减的泄漏。
 */
@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithIdentity>();
    const response = http.getResponse<Response>();
    const requestId = this.readRequestId(request) || randomUUID();
    const startedAt = process.hrtime.bigint();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    this.metrics.activeHttpRequests.inc({ method: request.method });

    let recorded = false;
    const record = () => {
      if (recorded) {
        return;
      }
      recorded = true;

      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const labels = {
        method: request.method,
        route: this.routeTemplate(request),
        status_code: String(response.statusCode),
      };

      this.metrics.activeHttpRequests.dec({ method: request.method });
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, durationSeconds);
    };

    response.once('finish', record);
    response.once('close', record);

    return next.handle();
  }

  private readRequestId(request: Request) {
    const value = request.headers['x-request-id'];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * 用路由模板而非真实路径做标签，避免 /api/device/:id 这类路径把
   * 每个设备 id 变成一条独立时间序列（基数爆炸会拖垮 Prometheus）。
   * 未匹配到路由的请求统一归为 unmatched，同理防止扫描器刷爆基数。
   */
  private routeTemplate(request: Request) {
    const route = request.route as { path?: string } | undefined;
    return route?.path ? `${request.baseUrl}${route.path}` : 'unmatched';
  }
}
