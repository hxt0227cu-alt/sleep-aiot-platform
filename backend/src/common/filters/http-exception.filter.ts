import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * HTTP异常过滤器
 * 统一处理所有HTTP异常，返回标准化的错误响应
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    // 记录错误日志
    this.logError(exception, request);

    // 构建错误响应
    const errorResponse = this.buildErrorResponse(
      exception,
      request,
      status,
      exceptionResponse,
    );

    response.status(status).json(errorResponse);
  }

  /**
   * 记录错误日志
   */
  private logError(exception: HttpException, request: Request) {
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any).message || 'Internal server error';

    // 根据状态码决定日志级别
    if (status >= 500) {
      this.logger.error(
        `${status} ${request.method} ${request.url} - ${message}`,
        exception.stack,
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${status} ${request.method} ${request.url} - ${message}`,
      );
    } else {
      this.logger.debug(
        `${status} ${request.method} ${request.url} - ${message}`,
      );
    }
  }

  /**
   * 构建错误响应
   */
  private buildErrorResponse(
    exception: HttpException,
    request: Request & { requestId?: string },
    status: number,
    exceptionResponse: any,
  ) {
    const baseResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      requestId: request.requestId,
    };

    // 处理不同类型的异常响应
    if (typeof exceptionResponse === 'string') {
      return {
        ...baseResponse,
        message: exceptionResponse,
        error: this.getErrorType(status),
      };
    }

    if (typeof exceptionResponse === 'object') {
      const responseObj = exceptionResponse;

      return {
        ...baseResponse,
        message: responseObj.message || 'Internal server error',
        error: responseObj.error || this.getErrorType(status),
        ...(responseObj.details && { details: responseObj.details }),
        ...(responseObj.errors && { errors: responseObj.errors }),
        ...(responseObj.validationErrors && {
          validationErrors: responseObj.validationErrors,
        }),
      };
    }

    return {
      ...baseResponse,
      message: 'Internal server error',
      error: this.getErrorType(status),
    };
  }

  /**
   * 根据状态码获取错误类型
   */
  private getErrorType(status: number): string {
    const errorTypes: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      405: 'METHOD_NOT_ALLOWED',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
      504: 'GATEWAY_TIMEOUT',
    };

    return errorTypes[status] || 'UNKNOWN_ERROR';
  }

  /**
   * 获取用户友好的错误消息
   */
  private getUserFriendlyMessage(status: number, message: string): string {
    const friendlyMessages: Record<number, string> = {
      400: '请求参数错误，请检查您的输入',
      401: '未授权，请先登录',
      403: '无权限访问此资源',
      404: '请求的资源不存在',
      405: '不支持的请求方法',
      409: '资源冲突，请稍后重试',
      422: '无法处理的请求实体',
      429: '请求过于频繁，请稍后重试',
      500: '服务器内部错误，请稍后重试',
      502: '网关错误，请稍后重试',
      503: '服务暂时不可用，请稍后重试',
      504: '网关超时，请稍后重试',
    };

    return friendlyMessages[status] || message;
  }
}

/**
 * 全局异常过滤器
 * 捕获所有未处理的异常
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    // 记录未处理的异常
    this.logger.error(
      `Unhandled exception: ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    // 返回500错误响应
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message: '服务器内部错误',
      error: 'INTERNAL_SERVER_ERROR',
      requestId: request.requestId,
    };

    response.status(status).json(errorResponse);
  }
}
