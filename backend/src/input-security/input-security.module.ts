import { Module } from '@nestjs/common';
import { PromptInjectionGuardService } from './prompt-injection-guard.service';
import { ContentSafetyService } from './content-safety.service';
import { InputSecurityInterceptor } from './input-security.interceptor';
import { UnifiedAuditModule } from '../unified-audit/unified-audit.module';

/**
 * 输入安全防护模块
 *
 * 提供提示词注入防护、内容安全检测、全局输入安全拦截能力。
 */
@Module({
  imports: [UnifiedAuditModule],
  providers: [PromptInjectionGuardService, ContentSafetyService, InputSecurityInterceptor],
  exports: [PromptInjectionGuardService, ContentSafetyService],
})
export class InputSecurityModule {}
