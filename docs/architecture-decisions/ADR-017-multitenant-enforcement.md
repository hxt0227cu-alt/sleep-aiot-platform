# ADR-017: 多租户强制隔离（Layer 1）

## Status

Accepted

## Context

生产就绪度评估（见 `04`/`05`）把"多租户隔离为零"列为**安全级**缺口：

- `tenantId` 列只存在于 6 个模型（`Device`、`TenantMember`、`TenantQuota`、`AgentRun`、`AuditEvent`、`OutboxEvent`），且部分可为空。
- 全局**没有任何行级过滤**（`PrismaService` 仅 13 行，无 `$extends`、无 PostgreSQL RLS）。任何忘记在 `where` 里加 `tenantId` 的查询都会跨租户返回数据；越权只取决于能否猜到 `userId`。
- **核心健康表（`SleepReport` / `VitalSignsData` / `SleepStateData` / `AlarmRecord` / `SleepPlan` / `SleepDiary` / `SleepRoutineRecord` / `SleepRelaxRecord`）根本没有 `tenant_id` 列**——这一层本机制无法为它们做行级隔离。

JWT 链路已经携带 `tenantId`（`auth.service.ts` 签发时写入，`JwtAuthGuard` 挂到 `request.user.tenantId`），因此"请求级租户上下文"已具备，缺的是把它**强制**落到每一个查询上。

## Decision

分两层，本 ADR 只落地 Layer 1，Layer 2 作为独立数据迁移单列（见"后果"）。

### Layer 1（本 ADR，已落地、已单测）

1. **请求级租户上下文**（`tenant/tenant-context.ts`）：用 `AsyncLocalStorage` 在单次请求内保存 `tenantId`；并提供 `runBypass` 逃生舱给跨租户的系统操作。
2. **全局过滤扩展**（`tenant/tenant-scope.ts`）：
   - 纯函数 `scopeArgs(model, op, args, tenantId)` 为安全核心：写操作把 `tenantId` 注入 `data`（**context 值永远覆盖调用方传入的值**，防越权写入）；读/改/删把 `tenantId` 合入 `where`（与调用方条件 AND）；`TENANTED_MODELS` 集合外的模型原样放行。
   - `makeTenantQueryExtension()` 用 Prisma `$extends` 在**查询执行时刻**从 ALS 读取 `tenantId` 并应用 `scopeArgs`。
   - `args.__tenantBypass=true` 可跳过过滤（系统操作显式声明）。
3. **拦截器**（`tenant/tenant-scope.interceptor.ts`，全局注册于 `main.ts`）：守卫（先于拦截器执行）已写好 `req.user.tenantId`，拦截器把它灌入 ALS。
4. **零注入改动**（`database/prisma.service.ts`）：构造时 `this.$extends(...)` 并用 `Proxy` 返回——所有模型委托走 scoped 扩展，生命周期方法（`$connect`/`$disconnect`）与自身成员（`connectionLimit`）留在基类。`$extends` 与原客户端共享同一引擎/连接池，不额外占连接。
5. **fail-open（无租户上下文时跳过过滤）+ 记录**：避免在未审计完所有内部/系统路径前直接打挂应用；无上下文命中会进入 `unscopedHits` 计数，便于后续收紧。

### Layer 2（独立迁移，本 ADR 不执行）

给 8 张核心健康表补 `tenant_id` 列 + 回填策略（按 `device → user → tenant` 血缘推导或默认租户），再将其纳入 `TENANTED_MODELS`；并将 fail-open 收紧为 **fail-closed**（无上下文访问租户模型即拒绝）。须单独变更记录、独立回滚、含回填演练。

## Consequences

**变容易**
- 6 个已带 `tenantId` 的模型：即使 service 忘记在 `where` 里加租户条件，扩展也会自动补上——"忘写 scope" 这类 bug 被消除。
- 写操作自动注入 `tenantId`，且 context 值不可被调用方覆盖——杜绝"用别人的 tenantId 拼写入"的越权。

**变困难 / 须持续维护**
- `TENANTED_MODELS` 必须与 `schema.prisma` 中实际带 `tenantId` 的模型保持同步；新增租户模型却漏登记 = 该模型不被隔离。
- 确实需要跨租户的系统/后台任务必须显式 `TenantContext.runBypass(...)`，否则看不到别的租户数据。
- fail-open 意味着"忘了设置 ALS 的认证路径"目前不会硬失败（仅被记录），须靠 `unscopedHits` 监控 + Layer 2 的 fail-closed 收口。

**取舍（明确说出来）**
- 选 **ALS + Proxy** 而非"请求级 scoped provider"：后者要把所有 service 的 `PrismaService` 注入改成 `ScopedPrismaService`，波及面大、易漏；Proxy 让隔离对调用方透明。代价是 Proxy 略"巧妙"，已在注释中说明。
- 选 **fail-open** 而非 **fail-closed**：避免在未审计完内部路径时直接打挂应用。这是有意的渐进式收紧，非永久状态。

## 验证

- `tenant/tenant-scope.spec.ts`：21 个用例覆盖 `scopeArgs` 全操作（find/create/createMany/upsert/update/...）、非租户模型放行、bypass 剥离、扩展胶水（模拟 Prisma `$extends` 契约，验证 ALS 有/无租户时的行为）。
- `tenant/tenant-scope.interceptor.spec.ts`：验证 `req.user.tenantId` 透传进 ALS，且下游异步调用仍在上下文内。
- `database/prisma.service.tenant.spec.ts`：验证 `PrismaService` 套上 Proxy 后仍可构造、模型委托可达。
- **诚实边界**：以上为单测级验证，证明的是"隔离逻辑正确"。真实多租户行为（两个租户各自数据互不可见）需要一次有 2 个租户 + 真实 PG 的集成测试，属于 Layer 2 的验证闭环。
