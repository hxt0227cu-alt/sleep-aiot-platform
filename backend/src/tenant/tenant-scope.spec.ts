import {
  scopeArgs,
  makeTenantQueryExtension,
  TENANTED_MODELS,
  HEALTH_TENANTED_MODELS,
  TENANT_BYPASS_KEY,
  isStrictFailClosed,
  type PrismaArgs,
  type TenantQueryHookArgs,
} from './tenant-scope';
import { TenantContext } from './tenant-context';

/**
 * scopeArgs 返回 `Record<string, unknown>`（刻意不用 any，见 tenant-scope.ts 注释）。
 * 断言时需要把某个片段收敛回记录形状；集中在这个辅助里，避免测试里散落类型断言。
 */
const rec = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;

describe('scopeArgs (ADR-017 安全核心)', () => {
  const TID = 'tenant-1';

  it('非租户模型原样返回', () => {
    const args = { where: { id: 'u1' } };
    expect(scopeArgs('User', 'findMany', args, TID)).toBe(args);
  });

  it('findMany 合并 tenantId 到已有 where', () => {
    const out = scopeArgs(
      'Device',
      'findMany',
      { where: { status: 'active' } },
      TID,
    );
    expect(out.where).toEqual({ status: 'active', tenantId: TID });
  });

  it('findMany 无 where 时补 tenantId', () => {
    const out = scopeArgs('Device', 'findMany', {}, TID);
    expect(out.where).toEqual({ tenantId: TID });
  });

  it('findUnique 合并 tenantId（防凭 id 跨租户读取）', () => {
    const out = scopeArgs('Device', 'findUnique', { where: { id: 'd1' } }, TID);
    expect(out.where).toEqual({ id: 'd1', tenantId: TID });
  });

  it('create 注入 tenantId，且覆盖调用方传入的值', () => {
    const out = scopeArgs(
      'Device',
      'create',
      { data: { id: 'd1', tenantId: 'evil' } },
      TID,
    );
    expect(rec(out.data).tenantId).toBe(TID);
  });

  it('createMany 数组每个元素都注入 tenantId', () => {
    const out = scopeArgs(
      'Device',
      'createMany',
      { data: [{ id: 'a' }, { id: 'b' }] },
      TID,
    );
    expect(out.data).toEqual([
      { id: 'a', tenantId: TID },
      { id: 'b', tenantId: TID },
    ]);
  });

  it('upsert 的 create 与 update 都注入 tenantId', () => {
    const out = scopeArgs(
      'Device',
      'upsert',
      { where: { id: 'd1' }, create: { id: 'd1' }, update: { name: 'x' } },
      TID,
    );
    expect(rec(out.create).tenantId).toBe(TID);
    expect(rec(out.update).tenantId).toBe(TID);
  });

  it('update / updateMany / delete / deleteMany 合并 where', () => {
    expect(
      scopeArgs('Device', 'update', { where: { id: 'd1' }, data: {} }, TID)
        .where,
    ).toEqual({
      id: 'd1',
      tenantId: TID,
    });
    expect(scopeArgs('Device', 'updateMany', { where: {} }, TID).where).toEqual(
      { tenantId: TID },
    );
    expect(
      scopeArgs('Device', 'delete', { where: { id: 'd1' } }, TID).where,
    ).toEqual({
      id: 'd1',
      tenantId: TID,
    });
    expect(scopeArgs('Device', 'deleteMany', { where: {} }, TID).where).toEqual(
      { tenantId: TID },
    );
  });

  it('count / aggregate / groupBy 合并 where', () => {
    expect(
      scopeArgs('Device', 'count', { where: { status: 'x' } }, TID).where,
    ).toEqual({
      status: 'x',
      tenantId: TID,
    });
  });

  it('__tenantBypass 透传且剥离标记键', () => {
    const args = { where: { id: 'd1' }, [TENANT_BYPASS_KEY]: true };
    const out = scopeArgs('Device', 'findMany', args, TID);
    expect(out).not.toHaveProperty(TENANT_BYPASS_KEY);
    expect(out.where).toEqual({ id: 'd1' });
  });

  // 回归保护：调用方误把标量当作 where/data 传入时，绝不能被展开成
  // { 0:'d', 1:'1' } 这种"语法合法、语义完全错误"的查询条件。
  it('where/data 为标量时收敛为纯 tenantId 约束而非逐字符展开', () => {
    // 若直接 { ...'oops' }，会得到 { 0:'o', 1:'o', 2:'p', 3:'s' } —— 一个
    // 不会报错但语义完全错误的查询条件。asRecord 必须把它收敛掉。
    expect(
      scopeArgs('Device', 'findMany', { where: 'oops' }, TID).where,
    ).toEqual({ tenantId: TID });
    expect(scopeArgs('Device', 'create', { data: 42 }, TID).data).toEqual({
      tenantId: TID,
    });
  });
});

/** 假 Prisma 扩展契约：只描述本模块真正依赖的那一小块形状。 */
interface TenantExtension {
  query: {
    $allModels: {
      $allOperations: (hook: TenantQueryHookArgs) => Promise<unknown>;
    };
  };
}

function makeFakeClient() {
  const captured: PrismaArgs[] = [];
  const query = (args: PrismaArgs): Promise<unknown> => {
    captured.push(args);
    return Promise.resolve({ id: 'x' });
  };
  const extend = (ext: TenantExtension) => {
    const allOps = ext.query.$allModels.$allOperations;
    const call =
      (model: string, operation: string) =>
      (args: PrismaArgs): Promise<unknown> =>
        allOps({ model, operation, args, query });
    return {
      Device: {
        findMany: call('Device', 'findMany'),
        create: call('Device', 'create'),
      },
      User: { findMany: call('User', 'findMany') },
      SleepReport: {
        findMany: call('SleepReport', 'findMany'),
        create: call('SleepReport', 'create'),
      },
    };
  };
  return { extend, captured };
}

describe('makeTenantQueryExtension 胶水（模拟 Prisma $extends 契约）', () => {
  it('ALS 有 tenantId 时给租户模型加约束', async () => {
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await TenantContext.run('tenant-9', () =>
      scoped.Device.findMany({ where: { status: 'active' } }),
    );
    expect(captured[0].where).toEqual({
      status: 'active',
      tenantId: 'tenant-9',
    });
  });

  it('无租户上下文时对租户模型跳过过滤', async () => {
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await scoped.Device.findMany({ where: { status: 'active' } });
    expect(captured[0].where).toEqual({ status: 'active' });
  });

  it('无租户上下文时拒绝访问核心健康模型', () => {
    const { extend } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    expect(() => scoped.SleepReport.findMany({ where: {} })).toThrow(
      'Tenant context is required for health model',
    );
  });

  it('系统路径显式携带 tenantId 时允许写核心健康模型', async () => {
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await scoped.SleepReport.create({
      data: { id: 'report-1', tenantId: 'tenant-9' },
    });
    expect(captured[0].data).toEqual({
      id: 'report-1',
      tenantId: 'tenant-9',
    });
  });

  it('非租户模型永不加约束', async () => {
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await TenantContext.run('tenant-9', () =>
      scoped.User.findMany({ where: { id: 'u1' } }),
    );
    expect(captured[0].where).toEqual({ id: 'u1' });
  });

  it('bypass 模式跳过过滤', async () => {
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await TenantContext.runBypass(() =>
      scoped.Device.findMany({ where: { id: 'd1' } }),
    );
    expect(captured[0].where).toEqual({ id: 'd1' });
  });
});

describe('严格模式 TENANT_FAIL_CLOSED（P2 审计收紧）', () => {
  const prev = process.env.TENANT_FAIL_CLOSED;

  afterEach(() => {
    if (prev === undefined) delete process.env.TENANT_FAIL_CLOSED;
    else process.env.TENANT_FAIL_CLOSED = prev;
  });

  it('默认关闭：非健康租户模型无上下文放行', () => {
    delete process.env.TENANT_FAIL_CLOSED;
    expect(isStrictFailClosed()).toBe(false);
    const { extend } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    expect(() => scoped.Device.findMany({ where: { status: 'x' } })).not.toThrow();
  });

  it('开启后：非健康租户模型无上下文且无显式 tenantId 抛错', () => {
    process.env.TENANT_FAIL_CLOSED = '1';
    expect(isStrictFailClosed()).toBe(true);
    const { extend } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    expect(() => scoped.Device.findMany({ where: {} })).toThrow(
      'Tenant context is required for Device.findMany',
    );
  });

  it('开启后：显式携带 tenantId 的系统路径仍放行', async () => {
    process.env.TENANT_FAIL_CLOSED = '1';
    const { extend, captured } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    await scoped.Device.create({
      data: { id: 'd1', tenantId: 'tenant-9' },
    });
    expect(captured[0].data).toEqual({ id: 'd1', tenantId: 'tenant-9' });
  });

  it('开启后：bypass 逃生舱仍放行', () => {
    process.env.TENANT_FAIL_CLOSED = '1';
    const { extend } = makeFakeClient();
    const scoped = extend(makeTenantQueryExtension());
    expect(() =>
      TenantContext.runBypass(() => scoped.Device.findMany({ where: {} })),
    ).not.toThrow();
  });
});

describe('TENANTED_MODELS', () => {
  it('包含平台模型、Layer 2 核心健康模型、算法提案模型与业务附属表', () => {
    expect([...TENANTED_MODELS].sort()).toEqual(
      [
        'AgentRun',
        'AlgorithmProposal',
        'AlgorithmProposalAction',
        'AuditEvent',
        'Device',
        'OutboxEvent',
        'TenantMember',
        'TenantQuota',
        // 20260818 P1：业务附属表
        'AlarmConfig',
        'DeviceBindingSession',
        'DeviceCommandRecord',
        'DeviceConfig',
        'EmergencyContact',
        'KnowledgeChunk',
        'LightAlarm',
        'ScheduledDeviceAction',
        'SleepRoutineTemplate',
        'UserDevice',
        ...HEALTH_TENANTED_MODELS,
      ].sort(),
    );
  });

  it('KnowledgeDocument 刻意不在集合内（global/tenant 双态，service 层显式隔离）', () => {
    expect(TENANTED_MODELS.has('KnowledgeDocument')).toBe(false);
  });

  it('新增模型与 schema 中带 tenantId 列的非豁免模型同步（防漂移回归）', () => {
    // schema.prisma 当前带 tenant_id 的模型清单（KnowledgeDocument 为豁免项，
    // 靠 service 层显式 scope/tenantId 过滤，见 tenant-scope.ts 顶部注释）。
    const schemaTenanted = [
      'Device',
      'AlarmRecord',
      'SleepPlan',
      'SleepRoutineRecord',
      'SleepDiary',
      'SleepRelaxRecord',
      'SleepReport',
      'VitalSignsData',
      'SleepStateData',
      'TenantMember',
      'TenantQuota',
      'AgentRun',
      'AlgorithmProposal',
      'AlgorithmProposalAction',
      'AuditEvent',
      'OutboxEvent',
      // 20260818 P1：业务附属表
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
    ];
    const exempt = new Set(['KnowledgeDocument']);
    const notIsolated = schemaTenanted.filter(
      (m) => !exempt.has(m) && !TENANTED_MODELS.has(m),
    );
    expect(notIsolated).toEqual([]);
  });
});
