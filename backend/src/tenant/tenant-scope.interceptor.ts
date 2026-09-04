import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { TenantContext } from './tenant-context';

/**
 * 把请求级租户上下文灌入 AsyncLocalStorage（ADR-017）。
 *
 * NestJS 生命周期中守卫（JwtAuthGuard）先于拦截器执行，因此到达本拦截器时
 * `req.user.tenantId` 已由 JWT 校验链路写入。这里只需把它放进 ALS，后续任何
 * Prisma 查询（在处理器及其异步调用中）都能透明读到。
 *
 * 无认证请求（health / login）user 为空 -> tenantId=null -> ALS 空上下文 ->
 * 查询扩展跳过过滤（这些路径本就不触碰租户模型）。
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { tenantId?: string } }>();
    const tenantId = req?.user?.tenantId ?? null;
    return TenantContext.run(tenantId, () => next.handle());
  }
}
