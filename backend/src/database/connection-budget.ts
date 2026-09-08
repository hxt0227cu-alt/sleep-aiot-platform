/**
 * 数据库连接预算（ADR-016）。
 *
 * 问题：backend 在 K8s 中 HPA 可扩到 20 副本，若每副本都按 Prisma 默认连接池
 * （通常与 CPU 核数挂钩）建连，20 副本会瞬间打爆 PostgreSQL 的 max_connections。
 *
 * 方案：把连接数当作集群级预算来分配。每副本允许的连接上限 =
 *   floor((PG_MAX_CONNECTIONS - 预留) / 最大副本数)
 * 这样无论扩到多少副本，总和都不会越过 PG 上限。预留额度留给迁移任务、管理员
 * 连入与意外的突发。
 *
 * PgBouncer（transaction 模式）作为"连接数超过阈值时"的触发项引入，而非默认项：
 * 在副本数 × 每副本连接数 仍可控时，直连更简单；只有当预算算出的每副本连接数
 * 过低（< 2）时才必须上 PgBouncer 做连接复用。
 */

export interface ConnectionBudgetInput {
  pgMaxConnections: number;
  reserved: number;
  maxReplicas: number;
}

/** 计算每副本可申请的 Prisma 连接上限。最小为 1，保证单副本也能工作。 */
export function computeConnectionLimit(input: ConnectionBudgetInput): number {
  const usable = Math.max(1, input.pgMaxConnections - input.reserved);
  return Math.max(1, Math.floor(usable / Math.max(1, input.maxReplicas)));
}

// v7（driver adapter）下连接预算经 PrismaPg 的 pg 池 max 生效（见 prisma.service.ts），
// 不再向 DATABASE_URL 注入 Prisma 引擎专用参数，原 withConnectionLimit 已删除。

/** 当预算算出的每副本连接数过低时，必须启用 PgBouncer（transaction 模式）。 */
export function requiresPgBouncer(perReplicaLimit: number): boolean {
  return perReplicaLimit < 2;
}
