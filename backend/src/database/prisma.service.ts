import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { computeConnectionLimit, requiresPgBouncer } from './connection-budget';
import { makeTenantQueryExtension } from '../tenant/tenant-scope';

/**
 * Prisma 连接治理（ADR-016）。
 *
 * 把数据库连接当作"集群级预算"分配：每副本上限 = floor((PG_MAX - 预留) / 最大副本数)。
 * 这样无论 K8s HPA 把 backend 扩到多少副本，副本连接总和都不会越过 PG max_connections。
 *
 * 当预算算出的每副本上限 < 2 时，单副本连接不足以支撑并发，必须启用 PgBouncer
 * （transaction 模式）做连接复用——此时会打出 WARN 提示，而非默认引入。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  readonly connectionLimit: number;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL || '';
    const maxReplicas = Number(
      process.env.BACKEND_MAX_REPLICAS || process.env.MAX_REPLICAS || '20',
    );
    const pgMax = Number(process.env.PG_MAX_CONNECTIONS || '100');
    const reserved = Number(process.env.PG_RESERVED_CONNECTIONS || '20');

    const limit = computeConnectionLimit({
      pgMaxConnections: pgMax,
      reserved,
      maxReplicas,
    });

    // Prisma ORM v7：datasources 选项已移除，强制 driver adapter。
    // ADR-016 连接预算经 PrismaPg 的 pg 池 max 生效，连接串不再注入
    // connection_limit/pool_timeout/connect_timeout（v5 引擎专用参数）。
    const adapter = databaseUrl
      ? new PrismaPg({
          connectionString: databaseUrl,
          max: limit,
          connectionTimeoutMillis: 10_000,
        })
      : undefined;
    super({ adapter: adapter as never });
    this.connectionLimit = limit;

    if (requiresPgBouncer(limit)) {
      this.logger.warn(
        `[ADR-016] 每副本连接上限=${limit}（<2）。backend 副本数接近上限时必须启用 PgBouncer（transaction 模式）复用连接，否则会打满 PG max_connections。`,
      );
    } else {
      this.logger.log(
        `[ADR-016] Prisma 连接池上限=${limit}（PG_MAX=${pgMax}, 预留=${reserved}, 最大副本=${maxReplicas}）`,
      );
    }

    // ADR-017：把客户端包成「租户作用域」版本。返回 Proxy——所有模型委托
    // （device / user / ...）走 scoped 扩展（查询时按 ALS 中的 tenantId 过滤），
    // 而生命周期方法（$connect/$disconnect）与自身成员（connectionLimit）
    // 仍落在基类，避免改动任何 service 的注入点。
    // 注意：$extends 返回的客户端与原客户端共享同一底层引擎与连接池，不会
    // 额外占连接。
    const scoped = this.$extends(makeTenantQueryExtension());
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in scoped) {
          const v = (scoped as unknown as Record<string, unknown>)[prop];
          if (v !== undefined) return v;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
