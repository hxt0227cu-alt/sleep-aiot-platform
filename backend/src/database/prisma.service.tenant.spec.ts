import { PrismaService } from './prisma.service';

/**
 * 验证 PrismaService 在构造时套上租户作用域 Proxy 后仍能正常实例化，
 * 且所有模型委托（device / user）可用、生命周期成员（connectionLimit）留在基类。
 * 不连接真实数据库——只验证 Proxy 接线不破坏构造与委托可达性。
 */
/**
 * Prisma 的模型委托（prisma.device / prisma.user）是运行时动态属性，
 * 类型层面拿不到。用一个受控的索引访问替代散落的 `as any`，
 * 这样"哪些地方绕过了类型系统"在文件里只有一处、可审计。
 */
const delegate = (
  client: PrismaService,
  model: string,
): Record<string, unknown> =>
  (client as unknown as Record<string, Record<string, unknown>>)[model];

describe('PrismaService 租户作用域接线 (ADR-017)', () => {
  const prev = process.env.DATABASE_URL;
  beforeAll(() => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ||
      'postgresql://u:p@localhost:5432/sleep_monitor_test';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });

  it('构造不抛错且 connectionLimit 为数字', () => {
    const prisma = new PrismaService();
    expect(typeof prisma.connectionLimit).toBe('number');
  });

  it('租户模型委托可访问（走 scoped 扩展）', () => {
    const prisma = new PrismaService();
    expect(delegate(prisma, 'device')).toBeTruthy();
    expect(typeof delegate(prisma, 'device').findMany).toBe('function');
  });

  it('非租户模型委托同样可访问', () => {
    const prisma = new PrismaService();
    expect(delegate(prisma, 'user')).toBeTruthy();
    expect(typeof delegate(prisma, 'user').findMany).toBe('function');
  });
});
