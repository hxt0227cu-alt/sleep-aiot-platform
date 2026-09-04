import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaService } from './prisma.service';

/**
 * DB 逻辑备份/恢复的"真实"验证（ADR-018）。
 *
 * 在 DATABASE_URL 可用且 pg_dump/pg_restore/psql 存在于 PATH 时：
 *   1) 建一张带已知行的临时表；
 *   2) 对整个库做 pg_dump（-Fc custom format）；
 *   3) 创建隔离的空目标库；
 *   4) pg_restore --clean --if-exists 恢复到目标库；
 *   5) 断言目标库中的表结构与数据已完整恢复。
 *
 * 工具或实例缺失时整体 describe.skip（本地无 PG/客户端不报红），
 * 由 CI 的 TimescaleDB service container + postgresql-client 真正执行。
 */

function hasTool(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const canRun = Boolean(
  DATABASE_URL &&
  hasTool('pg_dump') &&
  hasTool('pg_restore') &&
  hasTool('psql'),
);
const describeOrSkip = canRun ? describe : describe.skip;

interface SmokeRow {
  id: number;
  payload: string;
}

describeOrSkip('数据库逻辑备份/恢复（真实 pg_dump/pg_restore）', () => {
  let prisma: PrismaService;
  const table = `bkp_smoke_${Date.now()}`;
  const tmpDump = path.join(os.tmpdir(), `bkp-${Date.now()}.dump`);
  const restoreDatabase = `bkp_restore_${process.pid}_${Date.now()}`;
  const sourceUrl = new URL(
    DATABASE_URL ?? 'postgresql://localhost/sleep_monitor_test',
  );
  const adminUrl = new URL(sourceUrl);
  const restoreUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  restoreUrl.pathname = `/${restoreDatabase}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$queryRawUnsafe(
      `CREATE TABLE "${table}" (id int primary key, payload text)`,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO "${table}" (id, payload) VALUES (1,'alpha'),(2,'beta')`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma
        .$queryRawUnsafe(`DROP TABLE IF EXISTS "${table}"`)
        .catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    }
    execFileSync(
      'psql',
      [
        adminUrl.toString(),
        '--set=ON_ERROR_STOP=1',
        '--command',
        `DROP DATABASE IF EXISTS "${restoreDatabase}" WITH (FORCE)`,
      ],
      { stdio: 'pipe' },
    );
    fs.rmSync(tmpDump, { force: true });
  });

  it('pg_dump 全库 -> 隔离目标库 -> pg_restore 后结构与数据完整恢复', () => {
    // 1) 备份当前库（含测试表与已知行）
    execFileSync(
      'pg_dump',
      ['--no-owner', '-Fc', DATABASE_URL!, '-f', tmpDump],
      {
        stdio: 'pipe',
      },
    );
    expect(fs.existsSync(tmpDump)).toBe(true);

    // 2) 新建隔离目标库。扩展必须恢复到新库，不能在仍有连接的源库中原地重建。
    execFileSync(
      'psql',
      [
        adminUrl.toString(),
        '--set=ON_ERROR_STOP=1',
        '--command',
        `CREATE DATABASE "${restoreDatabase}" TEMPLATE template0`,
      ],
      { stdio: 'pipe' },
    );

    // 3) 将完整 dump 恢复到新库。
    execFileSync(
      'pg_restore',
      [
        '--clean',
        '--if-exists',
        '--no-owner',
        `--dbname=${restoreUrl.toString()}`,
        tmpDump,
      ],
      { stdio: 'pipe' },
    );

    // 4) 断言目标库中的结构与数据恢复。
    const restored = execFileSync(
      'psql',
      [
        restoreUrl.toString(),
        '--set=ON_ERROR_STOP=1',
        '--tuples-only',
        '--no-align',
        '--command',
        `SELECT json_agg(row_to_json(t)) FROM (SELECT id, payload FROM "${table}" ORDER BY id) t`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const rows = JSON.parse(restored) as SmokeRow[];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { id: 1, payload: 'alpha' },
      { id: 2, payload: 'beta' },
    ]);
  });
});
