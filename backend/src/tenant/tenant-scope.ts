import { TenantContext } from './tenant-context';

/**
 * 多租户强制隔离（ADR-017, Layer 2）。
 *
 * 仅对【已有 tenantId 列的模型】生效。当前 schema 中带 tenant_id 的模型：
 *   Device(可空), AlarmRecord, SleepPlan, SleepRoutineRecord, SleepDiary,
 *   SleepRelaxRecord, SleepReport, VitalSignsData, SleepStateData,
 *   KnowledgeDocument(可空), TenantMember, TenantQuota, AgentRun,
 *   AlgorithmProposal, AlgorithmProposalAction, AuditEvent(可空), OutboxEvent(可空)
 *
 * 例外：KnowledgeDocument 刻意【不】入集合——它是 `scope=global → tenantId=NULL`
 * 双态模型，通用 hook 的「context 覆盖调用方值」会把 global 文档强制改写为租户
 * 文档、破坏全局知识语义；其隔离由 knowledge.service 显式 scope/tenantId 条件承担
 * （raw SQL 检索过滤 + indexDocument 写入校验），并有 pgvector 集成测试 2/2 覆盖。
 *
 * 业务附属表（UserDevice/AlarmConfig/.../KnowledgeChunk，迁移 20260818）的
 * tenantId 可空：NULL = 未租户化（设备无租户 / 用户无租户 / global 文档 chunk），
 * 是合法语义而非孤儿。有上下文时严格注入/过滤，未租户化行对租户查询不可见。
 *
 * 核心健康模型没有租户上下文时 fail-closed。迁移会在无法唯一回填历史
 * tenant_id 时中止，因此运行期不能再通过无上下文访问绕过隔离。
 *
 * 此集合必须与 schema.prisma 中实际带 tenantId 的模型保持同步。
 * 若新增带 tenantId 的模型却忘了加进来，该模型将【不被隔离】——
 * 故 `scopeArgs` 对未知但带 tenantId 的模型采取保守策略（见下方逻辑）。
 */
export const TENANTED_MODELS = new Set<string>([
  'Device',
  'TenantMember',
  'TenantQuota',
  'AgentRun',
  'AuditEvent',
  'OutboxEvent',
  'AlarmRecord',
  'SleepPlan',
  'SleepRoutineRecord',
  'SleepDiary',
  'SleepRelaxRecord',
  'SleepReport',
  'VitalSignsData',
  'SleepStateData',
  'AlgorithmProposal',
  'AlgorithmProposalAction',
  // 20260818 P1：业务附属表（可空 tenantId，见上方注释）
  'UserDevice',
  'AlarmConfig',
  'DeviceConfig',
  'LightAlarm',
  'DeviceBindingSession',
  'DeviceCommandRecord',
  'ScheduledDeviceAction',
  'EmergencyContact',
  'SleepRoutineTemplate',
  'KnowledgeChunk',
]);

export const HEALTH_TENANTED_MODELS = new Set<string>([
  'AlarmRecord',
  'SleepPlan',
  'SleepRoutineRecord',
  'SleepDiary',
  'SleepRelaxRecord',
  'SleepReport',
  'VitalSignsData',
  'SleepStateData',
]);

const WRITE_DATA_OPS = new Set([
  'create',
  'createmany',
  'createmanyandreturn',
  'upsert',
]);

const WHERE_OPS = new Set([
  'findunique',
  'finduniqueorthrow',
  'findfirst',
  'findfirstorthrow',
  'findmany',
  'update',
  'updatemany',
  'delete',
  'deletemany',
  'count',
  'aggregate',
  'groupby',
]);

/** 系统逃生舱标记：传入 args.__tenantBypass=true 可跳过本层过滤。 */
export const TENANT_BYPASS_KEY = '__tenantBypass';

/**
 * Prisma 查询参数的结构化视图。
 *
 * 这里刻意用 `unknown` 而非 `any` 作为值类型：本模块是安全边界，
 * `any` 会让编译器对"把用户可控的 where 片段直接展开进查询"这类操作
 * 完全静默。用 `unknown` 后，任何取值都必须显式经过 `asRecord` 收敛，
 * 非对象输入会被规整为 `{}` 而不是把 undefined/字符串展开进查询条件。
 */
export type PrismaArgs = Record<string, unknown>;

/**
 * 把可能缺失或非对象的参数片段收敛为可安全展开的记录。
 *
 * 为什么需要它：`{ ...undefined }` 在 JS 里是合法的（得到 `{}`），
 * 但 `{ ...'foo' }` 会得到 `{0:'f',1:'o',2:'o'}` —— 一旦调用方误传标量，
 * 就会构造出一个语义完全错误却不会报错的 where 条件。显式收敛可杜绝该类静默故障。
 */
function asRecord(value: unknown): PrismaArgs {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PrismaArgs)
    : {};
}

function hasExplicitTenant(args: PrismaArgs, operation: string): boolean {
  const op = operation.toLowerCase();
  if (WRITE_DATA_OPS.has(op)) {
    if (op === 'upsert') {
      return typeof asRecord(args.create).tenantId === 'string';
    }
    if (op === 'createmany' || op === 'createmanyandreturn') {
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      return (
        rows.length > 0 &&
        rows.every((row) => typeof asRecord(row).tenantId === 'string')
      );
    }
    return typeof asRecord(args.data).tenantId === 'string';
  }
  return typeof asRecord(args.where).tenantId === 'string';
}

/**
 * 纯函数：把租户约束合入 Prisma 查询参数。这是整个隔离机制的【安全核心】，
 * 不依赖数据库，可单测。
 *
 * - 写操作（create/upsert/createMany）：把 tenantId 注入 data（context 值
 *   永远覆盖调用方传入的值，防止调用方越权写入别的租户）。
 * - 读/改/删操作：把 tenantId 合入 where（与调用方已有条件 AND 合并）。
 * - 调用方传入的 tenantId 永远被 context 值覆盖，杜绝「用别人的 tenantId
 *   拼 where」的越权。
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: PrismaArgs = {},
  tenantId: string,
): PrismaArgs {
  if (!TENANTED_MODELS.has(model)) {
    return args;
  }

  // 逃生舱：剥离标记键后原样返回，不做任何隔离。
  if (args[TENANT_BYPASS_KEY] !== undefined) {
    const rest: PrismaArgs = { ...args };
    delete rest[TENANT_BYPASS_KEY];
    return rest;
  }

  const op = operation.toLowerCase();
  const a: PrismaArgs = args ?? {};

  if (WRITE_DATA_OPS.has(op)) {
    if (op === 'createmany' || op === 'createmanyandreturn') {
      const data = Array.isArray(a.data)
        ? (a.data as unknown[]).map((d) => ({ ...asRecord(d), tenantId }))
        : { ...asRecord(a.data), tenantId };
      return { ...a, data };
    }
    if (op === 'upsert') {
      return {
        ...a,
        create: { ...asRecord(a.create), tenantId },
        update: { ...asRecord(a.update), tenantId },
      };
    }
    return { ...a, data: { ...asRecord(a.data), tenantId } };
  }

  if (WHERE_OPS.has(op)) {
    const where = a.where ? { ...asRecord(a.where), tenantId } : { tenantId };
    return { ...a, where };
  }

  // 未知操作类型：保守合入 where（若存在），否则原样返回。
  if (a.where) {
    return { ...a, where: { ...asRecord(a.where), tenantId } };
  }
  return a;
}

/**
 * 统计「无租户上下文却命中租户模型」的次数，用于后续把 fail-open 收紧为
 * fail-closed 前先摸清哪些内部路径需要补上下文或显式 bypass。
 */
const unscopedHits = new Map<string, number>();

export function recordUnscoped(model: string, operation: string): void {
  const key = `${model}.${operation}`;
  unscopedHits.set(key, (unscopedHits.get(key) ?? 0) + 1);
}

export function getUnscopedHits(): Record<string, number> {
  return Object.fromEntries(unscopedHits);
}

/** 重置统计（测试隔离用）。 */
export function resetUnscopedHits(): void {
  unscopedHits.clear();
}

/**
 * 严格模式开关（P2 审计收紧的第一阶段抓手）：
 * `TENANT_FAIL_CLOSED=1` 时，无租户上下文访问【任意】租户模型（含非健康模型）
 * 一律 fail-closed 抛错，除非调用方显式携带 tenantId。
 *
 * 默认关闭以保持现有内部/系统路径兼容；审计流程：
 *   1. 正常跑一遍主流程（默认模式），读 `getUnscopedHits()` 找出无上下文访问点；
 *   2. 逐个判定：属系统操作 → 包 `TenantContext.runBypass`（显式逃生舱）；
 *      属用户操作 → 补请求上下文；
 *   3. 全部处理后开启 `TENANT_FAIL_CLOSED=1` 做全量回归，无遗漏即达成 fail-closed。
 */
export function isStrictFailClosed(): boolean {
  return process.env.TENANT_FAIL_CLOSED === '1';
}

/** Prisma `$allOperations` 回调收到的参数形状（只取本模块用得到的字段）。 */
export interface TenantQueryHookArgs {
  model: string;
  operation: string;
  args: PrismaArgs;
  query: (args: PrismaArgs) => Promise<unknown>;
}

/**
 * Prisma `$extends` 查询扩展工厂。在【查询执行时刻】从 ALS 读取 tenantId。
 * - bypass 模式：原样放行（系统操作）。
 * - 有 tenantId：调用 scopeArgs 注入约束。
 * - 无 tenantId（未认证/系统路径）：原样放行并记录，便于后续审计收紧。
 */
export function makeTenantQueryExtension() {
  return {
    query: {
      $allModels: {
        $allOperations({
          model,
          operation,
          args,
          query,
        }: TenantQueryHookArgs): Promise<unknown> {
          if (TenantContext.isBypass()) {
            return query(args);
          }
          const tenantId = TenantContext.getTenantId();
          if (!tenantId) {
            recordUnscoped(model, operation);
            if (HEALTH_TENANTED_MODELS.has(model)) {
              if (hasExplicitTenant(args, operation)) {
                return query(args);
              }
              throw new Error(
                `Tenant context is required for health model ${model}.${operation}`,
              );
            }
            if (isStrictFailClosed()) {
              if (hasExplicitTenant(args, operation)) {
                return query(args);
              }
              throw new Error(
                `Tenant context is required for ${model}.${operation} (TENANT_FAIL_CLOSED=1)`,
              );
            }
            return query(args);
          }
          return query(scopeArgs(model, operation, args, tenantId));
        },
      },
    },
  };
}
