import { of, Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { TenantContext } from './tenant-context';
import { TenantScopeInterceptor } from './tenant-scope.interceptor';

/** 只搭建拦截器真正读取的那一小块 ExecutionContext 形状。 */
function makeContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** 用给定的 handle 实现构造 CallHandler 替身。 */
function makeNext(handle: () => Observable<unknown>): CallHandler {
  return { handle } as CallHandler;
}

describe('TenantScopeInterceptor (ADR-017)', () => {
  const interceptor = new TenantScopeInterceptor();

  it('把 req.user.tenantId 透传到下游 ALS', (done) => {
    const req = { user: { tenantId: 't-9' } };
    let seen: string | null | undefined;
    const next = makeNext(() => {
      seen = TenantContext.getTenantId();
      return of(null);
    });
    interceptor.intercept(makeContext(req), next).subscribe(() => {
      expect(seen).toBe('t-9');
      done();
    });
  });

  it('无 user 时置为 null（未认证路径）', (done) => {
    const req = {};
    let seen: string | null | undefined;
    const next = makeNext(() => {
      seen = TenantContext.getTenantId();
      return of(null);
    });
    interceptor.intercept(makeContext(req), next).subscribe(() => {
      expect(seen).toBeNull();
      done();
    });
  });

  it('下游异步调用仍在 ALS 上下文内', (done) => {
    const req = { user: { tenantId: 't-7' } };
    let seen: string | null | undefined;
    const next = makeNext(() => {
      // 模拟 Nest：在 run 作用域内【同步发起】异步查询，ALS 才能随异步上下文传播
      const p = Promise.resolve().then(() => {
        seen = TenantContext.getTenantId();
      });
      return new Observable<void>((sub) => {
        void p.then(() => {
          sub.next();
          sub.complete();
        });
      });
    });
    interceptor.intercept(makeContext(req), next).subscribe(() => {
      expect(seen).toBe('t-7');
      done();
    });
  });
});
