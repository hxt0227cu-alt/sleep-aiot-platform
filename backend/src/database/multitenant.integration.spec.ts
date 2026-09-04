import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenant/tenant-context';

/**
 * 全局多租户隔离（ADR-017）真实数据库集成验证。
 *
 * 与 knowledge.pgvector.integration.spec.ts 同策略：仅在
 * RAG_PGVECTOR_DATABASE_URL 可用时执行，否则整体 skip。
 *
 * 覆盖点：
 * 1. create 自动注入 tenantId 且覆盖调用方显式值（防越权写他租户）
 * 2. 读隔离：findMany / findFirst（凭 id 跨租户读取返回 null）
 * 3. 写隔离：updateMany / deleteMany 跨租户影响 0 行
 * 4. 无租户上下文访问健康模型 fail-closed 抛错
 * 5. runBypass 逃生舱跳过过滤
 * 6. AlgorithmProposal / AlgorithmProposalAction 已入隔离集合（P0-1 回归）
 * 7. 交互式事务 tx 不经过 $extends（现状文档化）：事务内必须显式 tenantId，
 *    非空列由数据库约束兜底
 */
const databaseUrl = process.env.RAG_PGVECTOR_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('全局多租户隔离（真实 DB，ADR-017）', () => {
  const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const devA = 'dev-tenant-a';
  const devB = 'dev-tenant-b';

  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl!;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, name: 'Multitenant integration A' },
        { id: tenantB, name: 'Multitenant integration B' },
      ],
      skipDuplicates: true,
    });
    await prisma.device.createMany({
      data: [
        { id: devA, name: 'Device A', tenantId: tenantA },
        { id: devB, name: 'Device B', tenantId: tenantB },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // 清理必须走 bypass：健康模型在无上下文下会 fail-closed
    await TenantContext.runBypass(async () => {
      await prisma.sleepReport.deleteMany({
        where: { deviceId: { in: [devA, devB] } },
      });
      await prisma.algorithmProposalAction.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.algorithmProposal.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
      await prisma.agentRun.deleteMany({
        where: { tenantId: { in: [tenantA, tenantB] } },
      });
    });
  });

  const createReportA = () =>
    TenantContext.run(tenantA, () =>
      prisma.sleepReport.create({
        data: {
          deviceId: devA,
          reportDate: new Date('2026-08-18'),
          sleepScore: 80,
          tenantId: tenantA,
        },
      }),
    );

  it('create 自动注入 tenantId，且覆盖调用方显式传入的他租户值', async () => {
    // 调用方恶意/失误传 tenantB，context 为 tenantA → 落库必须是 tenantA
    const report = await TenantContext.run(tenantA, () =>
      prisma.sleepReport.create({
        data: {
          deviceId: devA,
          reportDate: new Date('2026-08-18'),
          tenantId: tenantB,
        },
      }),
    );
    expect(report.tenantId).toBe(tenantA);
  });

  it('findMany 只见本租户数据', async () => {
    await createReportA();
    await TenantContext.run(tenantB, () =>
      prisma.sleepReport.create({
        data: {
          deviceId: devB,
          reportDate: new Date('2026-08-18'),
          tenantId: tenantB,
        },
      }),
    );

    const fromA = await TenantContext.run(tenantA, () =>
      prisma.sleepReport.findMany({
        where: { deviceId: { in: [devA, devB] } },
      }),
    );
    const fromB = await TenantContext.run(tenantB, () =>
      prisma.sleepReport.findMany({
        where: { deviceId: { in: [devA, devB] } },
      }),
    );

    expect(fromA.map((r) => r.deviceId)).toEqual([devA]);
    expect(fromB.map((r) => r.deviceId)).toEqual([devB]);
  });

  it('凭 id 跨租户读/改/删均不可达', async () => {
    const report = await createReportA();

    const seenFromB = await TenantContext.run(tenantB, () =>
      prisma.sleepReport.findFirst({ where: { id: report.id } }),
    );
    expect(seenFromB).toBeNull();

    const updated = await TenantContext.run(tenantB, () =>
      prisma.sleepReport.updateMany({
        where: { id: report.id },
        data: { sleepScore: 1 },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await TenantContext.run(tenantB, () =>
      prisma.sleepReport.deleteMany({ where: { id: report.id } }),
    );
    expect(deleted.count).toBe(0);

    const stillThere = await TenantContext.run(tenantA, () =>
      prisma.sleepReport.findFirst({ where: { id: report.id } }),
    );
    expect(stillThere).not.toBeNull();
  });

  it('无租户上下文访问健康模型 fail-closed 抛错', async () => {
    await expect(prisma.sleepReport.findMany({ where: {} })).rejects.toThrow(
      'Tenant context is required',
    );
  });

  it('runBypass 逃生舱跳过过滤且不注入', async () => {
    await createReportA();
    await TenantContext.run(tenantB, () =>
      prisma.sleepReport.create({
        data: {
          deviceId: devB,
          reportDate: new Date('2026-08-18'),
          tenantId: tenantB,
        },
      }),
    );
    const all = await TenantContext.runBypass(() =>
      prisma.sleepReport.findMany({ where: {} }),
    );
    expect(all.map((r) => r.deviceId).sort()).toEqual([devA, devB].sort());
  });

  it('AlgorithmProposal 已入集合：create 注入 + 跨租户不可见（P0-1）', async () => {
    const agentRun = await TenantContext.runBypass(() =>
      prisma.agentRun.create({
        data: {
          tenantId: tenantA,
          agentType: 'algorithm_optimization',
          input: { cohortId: 'cohort-0' },
        },
      }),
    );

    // 显式传 tenantB，context 为 tenantA → 被覆盖
    const proposal = await TenantContext.run(tenantA, () =>
      prisma.algorithmProposal.create({
        data: {
          tenantId: tenantB,
          agentRunId: agentRun.id,
          proposerId: 'user-a',
          workflowVersion: 'v1',
          policyVersion: 'algorithm-policy.v1',
          cohortCriteria: { cohortId: 'cohort-0' },
          parameterDiff: { brightness: 10 },
          hypothesis: 'h',
          rationale: 'r',
          primaryMetric: 'sleep_efficiency',
          guardrailMetrics: ['opt_out_rate'],
          sampleSize: 30,
          evidenceRef: 'ev-1',
          rollbackCondition: 'error_rate>0.1',
        },
      }),
    );
    expect(proposal.tenantId).toBe(tenantA);

    const inA = await TenantContext.run(tenantA, () =>
      prisma.algorithmProposal.findMany({ where: { id: proposal.id } }),
    );
    const inB = await TenantContext.run(tenantB, () =>
      prisma.algorithmProposal.findMany({ where: { id: proposal.id } }),
    );
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });

  it('事务内 tx 不经过 $extends：注入完全依赖显式 tenantId', async () => {
    // 交互式事务回调的 tx 是原始客户端，查询扩展不生效；事务内 create 的
    // tenantId 必须显式提供（SleepReport.tenantId 非空，漏传会被 DB 约束拒绝
    // 并整体回滚——机制安全，但这是与 hook 无关的另一道防线）。
    const created = await TenantContext.run(tenantA, () =>
      prisma.$transaction(async (tx) => {
        return tx.sleepReport.create({
          data: {
            deviceId: devA,
            reportDate: new Date('2026-08-19'),
            tenantId: tenantA,
          },
        });
      }),
    );
    expect(created.tenantId).toBe(tenantA);
  });
});
