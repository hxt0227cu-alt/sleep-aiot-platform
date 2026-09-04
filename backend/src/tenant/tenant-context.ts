import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级租户上下文（ADR-017）。
 *
 * 用 AsyncLocalStorage 在「一次请求」内保存当前 tenantId，使得 Prisma 的
 * `$extends` 查询扩展在【执行查询的时刻】能无侵入地读到它——而不需要改动
 * 任何 service 的构造函数注入。
 *
 * 设计取舍：
 * - 选 ALS 而非「请求级 scoped provider」：后者要把所有 service 的
 *   `PrismaService` 注入改成 `ScopedPrismaService`，波及面大、易漏。
 *   ALS + Proxy 让租户过滤对调用方完全透明。
 * - fail-open（无 tenantId 时跳过过滤）而非 fail-closed（抛错）：
 *   避免在未审计完所有内部/系统路径前直接打挂应用。无上下文的访问会被
 *   `tenant-scope.ts` 记录为 unscoped 命中，便于后续收紧为 fail-closed。
 * - `runBypass`：给确实要跨租户的系统操作（如租户管理、后台批处理）一个
 *   明确的逃生舱，比「偷偷不设置上下文」更可读、可审计。
 */
interface TenantStore {
  tenantId?: string | null;
  bypass?: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

export class TenantContext {
  /** 在 tenantId 上下文中执行 fn（通常为一次请求的处理链）。 */
  static run<T>(tenantId: string | null, fn: () => T): T {
    return storage.run({ tenantId }, fn);
  }

  /** 在跨租户（系统）上下文中执行 fn，跳过所有租户过滤。 */
  static runBypass<T>(fn: () => T): T {
    return storage.run({ bypass: true }, fn);
  }

  static getTenantId(): string | null | undefined {
    return storage.getStore()?.tenantId;
  }

  static isBypass(): boolean {
    return storage.getStore()?.bypass === true;
  }
}
