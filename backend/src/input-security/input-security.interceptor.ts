import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger, BadRequestException } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { PromptInjectionGuardService } from './prompt-injection-guard.service';
import { ContentSafetyService } from './content-safety.service';

/**
 * 输入安全拦截器
 *
 * 全局拦截所有进入 AI 链路的文本与语音内容，自动执行安全校验。
 */
@Injectable()
export class InputSecurityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(InputSecurityInterceptor.name);

  /** 需要安全校验的路径 */
  private readonly PROTECTED_PATHS = [
    '/api/assistant',
    '/api/voice/recognize',
    '/api/knowledge/ask',
    '/api/agent-run',
  ];

  constructor(
    private readonly promptInjectionGuard: PromptInjectionGuardService,
    private readonly contentSafety: ContentSafetyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const path = request.path as string;

    // 检查是否需要安全校验
    if (!this.requiresSecurityCheck(path)) {
      return next.handle();
    }

    try {
      // 提取需要校验的文本内容
      const textToCheck = this.extractTextContent(request);

      if (textToCheck && textToCheck.length > 0) {
        // 1. 提示词注入检测
        const injectionResult = this.promptInjectionGuard.detect(textToCheck);

        if (injectionResult.action === 'block') {
          this.logger.warn(`输入安全拦截: 提示词注入阻断, path=${path}, risk=${injectionResult.riskScore}`);
          throw new BadRequestException({
            message: '输入内容包含安全风险，已被拦截',
            code: 'INPUT_SECURITY_BLOCKED',
            riskScore: injectionResult.riskScore,
            threats: injectionResult.threats.map((t) => t.type),
          });
        }

        // 2. 内容安全检测
        const contentResult = this.contentSafety.detect(textToCheck, {
          detectPii: true,
          detectViolation: true,
          enforceProductBoundary: true,
          autoSanitize: false,
        });

        if (contentResult.action === 'block') {
          this.logger.warn(`输入安全拦截: 内容安全阻断, path=${path}, risk=${contentResult.riskScore}`);
          throw new BadRequestException({
            message: '输入内容包含违规信息，已被拦截',
            code: 'CONTENT_SAFETY_BLOCKED',
            riskScore: contentResult.riskScore,
            violations: contentResult.violations.map((v) => v.category),
          });
        }

        // 将检测结果附加到请求中，供下游使用
        request.inputSecurityResult = {
          injection: injectionResult,
          contentSafety: contentResult,
          checkedAt: new Date().toISOString(),
        };

        // 如果有 PII 检测到，记录日志但不阻断（除非配置为阻断）
        if (contentResult.piiDetected.length > 0) {
          this.logger.debug(`输入内容检测到 PII: ${contentResult.piiDetected.map((p) => p.type).join(',')}`);
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      // 安全检测本身出错，默认放行但记录日志（fail-open 策略）
      this.logger.error(`输入安全检测异常: ${error.message}，fail-open 放行`);
    }

    return next.handle().pipe(
      catchError((err) => {
        return throwError(() => err);
      }),
    );
  }

  /**
   * 检查路径是否需要安全校验
   */
  private requiresSecurityCheck(path: string): boolean {
    return this.PROTECTED_PATHS.some((p) => path.startsWith(p));
  }

  /**
   * 从请求中提取文本内容
   */
  private extractTextContent(request: Record<string, unknown>): string {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) return '';

    // 常见文本字段
    const textFields = ['question', 'message', 'text', 'content', 'prompt', 'input', 'query', 'voiceText', 'recognizedText'];
    for (const field of textFields) {
      if (body[field] && typeof body[field] === 'string') {
        return body[field] as string;
      }
    }

    // 嵌套对象中的文本
    if (body.data && typeof body.data === 'object') {
      const data = body.data as Record<string, unknown>;
      for (const field of textFields) {
        if (data[field] && typeof data[field] === 'string') {
          return data[field] as string;
        }
      }
    }

    return '';
  }
}
