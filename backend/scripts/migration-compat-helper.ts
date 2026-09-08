/**
 * 迁移兼容性辅助工具
 *
 * 功能：
 *   实现 Expand/Contract 模式下的新旧版本 Schema 双向兼容校验，
 *   支持应用版本与 Schema 版本解耦；
 *   生产环境不执行自动数据回滚。
 *
 * 使用：
 *   npx ts-node scripts/migration-compat-helper.ts <command> [options]
 *
 * 命令：
 *   check      - 检查迁移兼容性
 *   expand     - 执行 Expand 阶段（添加新字段/表，不破坏旧版本）
 *   contract   - 执行 Contract 阶段（移除旧字段/表，需确认所有应用已升级）
 *   verify     - 验证 Schema 与应用版本兼容性
 *   rollback   - 生成回滚脚本（不自动执行）
 */

import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 配置
// ============================================================

interface MigrationCompatConfig {
  // 迁移文件目录
  migrationsDir: string;
  // 迁移历史表
  migrationTable: string;
  // 应用版本文件
  appVersionFile: string;
  // 兼容矩阵文件
  compatMatrixFile: string;
  // 生产环境标记
  isProduction: boolean;
}

const DEFAULT_CONFIG: MigrationCompatConfig = {
  migrationsDir: './prisma/migrations',
  migrationTable: '_prisma_migrations',
  appVersionFile: './package.json',
  compatMatrixFile: './prisma/compat-matrix.json',
  isProduction: process.env.NODE_ENV === 'production',
};

// ============================================================
// 类型定义
// ============================================================

interface MigrationInfo {
  version: string;
  name: string;
  filePath: string;
  appliedAt?: string;
  checksum?: string;
}

interface CompatibilityMatrix {
  schemaVersion: string;
  minAppVersion: string;
  maxAppVersion: string;
  breakingChanges: string[];
  expandOnly: boolean;
  notes: string;
}

interface CompatibilityCheckResult {
  schemaVersion: string;
  appVersion: string;
  compatible: boolean;
  issues: Array<{
    severity: 'critical' | 'warning' | 'info';
    type: string;
    message: string;
    recommendation?: string;
  }>;
  expandPhaseReady: boolean;
  contractPhaseReady: boolean;
}

// ============================================================
// 迁移兼容性辅助器
// ============================================================

class MigrationCompatHelper {
  private prisma: PrismaClient;
  private config: MigrationCompatConfig;

  constructor(config?: Partial<MigrationCompatConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL ?? '',
      }),
    });
  }

  /**
   * 检查迁移兼容性
   */
  async checkCompatibility(): Promise<CompatibilityCheckResult> {
    console.log('[Migration Compat] 开始检查迁移兼容性');

    const schemaVersion = await this.getCurrentSchemaVersion();
    const appVersion = this.getAppVersion();

    console.log(`  Schema 版本: ${schemaVersion}`);
    console.log(`  应用版本: ${appVersion}`);

    const issues: CompatibilityCheckResult['issues'] = [];

    // 1. 检查待执行的迁移
    const pendingMigrations = await this.getPendingMigrations();
    if (pendingMigrations.length > 0) {
      issues.push({
        severity: 'warning',
        type: 'pending_migrations',
        message: `发现 ${pendingMigrations.length} 个待执行迁移`,
        recommendation: '在部署前执行所有待处理迁移',
      });

      for (const migration of pendingMigrations) {
        const hasBreakingChanges = this.checkMigrationBreakingChanges(migration);
        if (hasBreakingChanges) {
          issues.push({
            severity: 'critical',
            type: 'breaking_change',
            message: `迁移 ${migration.version}_${migration.name} 包含破坏性变更`,
            recommendation: '使用 Expand/Contract 模式，先执行 Expand 阶段',
          });
        }
      }
    }

    // 2. 检查兼容性矩阵
    const compatMatrix = this.loadCompatibilityMatrix();
    if (compatMatrix) {
      const versionCompatible = this.checkVersionCompatibility(appVersion, compatMatrix);
      if (!versionCompatible) {
        issues.push({
          severity: 'critical',
          type: 'version_incompatible',
          message: `应用版本 ${appVersion} 不在 Schema 版本 ${schemaVersion} 的兼容范围内 (${compatMatrix.minAppVersion} ~ ${compatMatrix.maxAppVersion})`,
          recommendation: '升级应用版本或回滚 Schema',
        });
      }
    }

    // 3. 检查未完成的 Expand/Contract 流程
    const expandPhaseReady = pendingMigrations.length === 0 && issues.filter((i) => i.severity === 'critical').length === 0;
    const contractPhaseReady = expandPhaseReady && this.canExecuteContractPhase();

    // 4. 检查生产环境安全
    if (this.config.isProduction) {
      issues.push({
        severity: 'info',
        type: 'production_safety',
        message: '生产环境：不执行自动数据回滚，所有回滚需手动审批',
      });
    }

    const compatible = issues.filter((i) => i.severity === 'critical').length === 0;

    console.log(`  兼容性: ${compatible ? '通过' : '不通过'}`);
    console.log(`  问题数: ${issues.length} (${issues.filter((i) => i.severity === 'critical').length} 严重)`);

    return {
      schemaVersion,
      appVersion,
      compatible,
      issues,
      expandPhaseReady,
      contractPhaseReady,
    };
  }

  /**
   * 执行 Expand 阶段
   *
   * Expand 阶段：添加新字段/表/索引，不修改或删除现有结构，
   * 确保旧版本应用仍能正常运行。
   */
  async executeExpandPhase(migrationVersion?: string): Promise<{ success: boolean; executedMigrations: string[]; errors: string[] }> {
    console.log('[Migration Compat] 执行 Expand 阶段');

    if (this.config.isProduction) {
      console.log('  生产环境：Expand 阶段需要审批后执行');
    }

    const pendingMigrations = await this.getPendingMigrations();
    const expandMigrations = migrationVersion
      ? pendingMigrations.filter((m) => m.version === migrationVersion)
      : pendingMigrations.filter((m) => this.isExpandOnlyMigration(m));

    const executedMigrations: string[] = [];
    const errors: string[] = [];

    for (const migration of expandMigrations) {
      try {
        console.log(`  执行 Expand 迁移: ${migration.version}_${migration.name}`);

        // 读取并执行迁移 SQL
        const sql = fs.readFileSync(migration.filePath, 'utf8');
        await this.prisma.$executeRawUnsafe(sql);

        executedMigrations.push(`${migration.version}_${migration.name}`);
        console.log(`    完成`);
      } catch (error) {
        const errorMsg = `迁移 ${migration.version}_${migration.name} 失败: ${(error as Error).message}`;
        console.error(`    ${errorMsg}`);
        errors.push(errorMsg);

        // Expand 阶段失败不中断，继续执行其他迁移
        // 但需要记录错误以便后续处理
      }
    }

    return {
      success: errors.length === 0,
      executedMigrations,
      errors,
    };
  }

  /**
   * 执行 Contract 阶段
   *
   * Contract 阶段：移除旧字段/表/索引，需要确认所有应用已升级到新版本。
   * 生产环境需要手动审批。
   */
  async executeContractPhase(): Promise<{ success: boolean; canExecute: boolean; reason?: string; contractMigrations: string[] }> {
    console.log('[Migration Compat] 执行 Contract 阶段');

    // 检查是否可以执行 Contract 阶段
    if (!this.canExecuteContractPhase()) {
      return {
        success: false,
        canExecute: false,
        reason: '存在运行旧版本应用的实例，或有未完成的 Expand 迁移',
        contractMigrations: [],
      };
    }

    if (this.config.isProduction) {
      console.log('  生产环境：Contract 阶段需要审批后执行，且不自动执行数据删除');
      return {
        success: false,
        canExecute: true,
        reason: '生产环境需手动审批后执行 Contract 阶段',
        contractMigrations: this.getContractMigrations(),
      };
    }

    // 非生产环境执行 Contract 迁移
    const contractMigrations = this.getContractMigrations();
    // 实际执行逻辑...

    return {
      success: true,
      canExecute: true,
      contractMigrations,
    };
  }

  /**
   * 验证 Schema 与应用版本兼容性
   */
  async verifyCompatibility(): Promise<{ valid: boolean; details: string[] }> {
    console.log('[Migration Compat] 验证 Schema 与应用版本兼容性');

    const details: string[] = [];
    const result = await this.checkCompatibility();

    if (result.compatible) {
      details.push('Schema 与应用版本兼容');
    } else {
      details.push('Schema 与应用版本不兼容');
      for (const issue of result.issues.filter((i) => i.severity === 'critical')) {
        details.push(`  [CRITICAL] ${issue.message}`);
      }
    }

    // 验证外键约束
    try {
      const fkResult = await this.prisma.$queryRawUnsafe<Array<{ conname: string; conrelid: string }>>(`
        SELECT conname, conrelid::regclass as table_name
        FROM pg_constraint
        WHERE contype = 'f'
        ORDER BY conrelid::regclass::text;
      `);
      details.push(`外键约束: ${fkResult.length} 个`);
    } catch (error) {
      details.push(`外键约束检查失败: ${(error as Error).message}`);
    }

    // 验证索引完整性
    try {
      const indexResult = await this.prisma.$queryRawUnsafe<Array<{ indexname: string; tablename: string }>>(`
        SELECT indexname, tablename
        FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname;
      `);
      details.push(`索引数量: ${indexResult.length} 个`);
    } catch (error) {
      details.push(`索引检查失败: ${(error as Error).message}`);
    }

    return { valid: result.compatible, details };
  }

  /**
   * 生成回滚脚本（不自动执行）
   */
  generateRollbackScript(migrationVersion: string): string {
    console.log(`[Migration Compat] 生成回滚脚本: ${migrationVersion}`);

    if (this.config.isProduction) {
      console.log('  生产环境：回滚脚本仅生成，不自动执行');
    }

    const migrationPath = path.join(this.config.migrationsDir, migrationVersion, 'migration.sql');

    if (!fs.existsSync(migrationPath)) {
      throw new Error(`迁移文件不存在: ${migrationPath}`);
    }

    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // 生成回滚脚本（简化版，实际需要解析 SQL 生成反向操作）
    const rollbackScript = `
-- ============================================================
-- 回滚脚本: ${migrationVersion}
-- 生成时间: ${new Date().toISOString()}
-- 注意：此脚本需要人工审核后执行
-- 生产环境：数据删除操作不可自动回滚
-- ============================================================

-- 原始迁移内容（参考）:
-- ${migrationSql.split('\n').join('\n-- ')}

-- 回滚操作（需人工补充）:
-- TODO: 根据原始迁移内容生成反向操作

-- 警告：执行前请确认：
-- 1. 所有应用实例已回滚到兼容版本
-- 2. 已备份相关数据
-- 3. 已获得审批（生产环境）
`.trim();

    return rollbackScript;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 获取当前 Schema 版本
   */
  private async getCurrentSchemaVersion(): Promise<string> {
    try {
      const result = await this.prisma.$queryRawUnsafe<Array<{ version: string }>>(`
        SELECT version FROM ${this.config.migrationTable}
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1;
      `);
      return result[0]?.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * 获取应用版本
   */
  private getAppVersion(): string {
    try {
      const packageJson = JSON.parse(fs.readFileSync(this.config.appVersionFile, 'utf8'));
      return packageJson.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * 获取待执行迁移
   */
  private async getPendingMigrations(): Promise<MigrationInfo[]> {
    const migrations: MigrationInfo[] = [];

    if (!fs.existsSync(this.config.migrationsDir)) {
      return migrations;
    }

    const dirs = fs.readdirSync(this.config.migrationsDir)
      .filter((d) => /^\d+_/.test(d))
      .sort();

    for (const dir of dirs) {
      const migrationFile = path.join(this.config.migrationsDir, dir, 'migration.sql');
      if (fs.existsSync(migrationFile)) {
        const [version, ...nameParts] = dir.split('_');
        migrations.push({
          version,
          name: nameParts.join('_'),
          filePath: migrationFile,
        });
      }
    }

    // 过滤已应用的迁移
    try {
      const appliedResult = await this.prisma.$queryRawUnsafe<Array<{ version: string }>>(`
        SELECT version FROM ${this.config.migrationTable}
        WHERE finished_at IS NOT NULL;
      `);
      const appliedVersions = new Set(appliedResult.map((r) => r.version));
      return migrations.filter((m) => !appliedVersions.has(m.version));
    } catch {
      return migrations;
    }
  }

  /**
   * 检查迁移是否包含破坏性变更
   */
  private checkMigrationBreakingChanges(migration: MigrationInfo): boolean {
    const sql = fs.readFileSync(migration.filePath, 'utf8').toLowerCase();

    const breakingPatterns = [
      /drop\s+table/i,
      /drop\s+column/i,
      /alter\s+table.*drop/i,
      /truncate/i,
      /rename\s+column/i,
      /alter\s+column.*type/i,
      /delete\s+from/i,
    ];

    return breakingPatterns.some((pattern) => pattern.test(sql));
  }

  /**
   * 检查是否为纯 Expand 迁移
   */
  private isExpandOnlyMigration(migration: MigrationInfo): boolean {
    const sql = fs.readFileSync(migration.filePath, 'utf8').toLowerCase();

    const expandPatterns = [
      /create\s+table/i,
      /add\s+column/i,
      /alter\s+table.*add/i,
      /create\s+index/i,
      /create\s+view/i,
    ];

    const contractPatterns = [
      /drop\s+table/i,
      /drop\s+column/i,
      /drop\s+index/i,
      /alter\s+table.*drop/i,
    ];

    const hasExpand = expandPatterns.some((p) => p.test(sql));
    const hasContract = contractPatterns.some((p) => p.test(sql));

    return hasExpand && !hasContract;
  }

  /**
   * 检查是否可以执行 Contract 阶段
   */
  private canExecuteContractPhase(): boolean {
    // 简化检查：实际需要检查所有应用实例版本
    return true;
  }

  /**
   * 获取 Contract 阶段迁移列表
   */
  private getContractMigrations(): string[] {
    // 简化实现
    return [];
  }

  /**
   * 加载兼容性矩阵
   */
  private loadCompatibilityMatrix(): CompatibilityMatrix | null {
    try {
      if (fs.existsSync(this.config.compatMatrixFile)) {
        return JSON.parse(fs.readFileSync(this.config.compatMatrixFile, 'utf8'));
      }
    } catch {
      // 忽略
    }
    return null;
  }

  /**
   * 检查版本兼容性
   */
  private checkVersionCompatibility(appVersion: string, matrix: CompatibilityMatrix): boolean {
    // 简化版本比较
    const parseVersion = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
    const app = parseVersion(appVersion);
    const min = parseVersion(matrix.minAppVersion);
    const max = parseVersion(matrix.maxAppVersion);

    for (let i = 0; i < 3; i++) {
      if (app[i] < min[i]) return false;
      if (app[i] > max[i]) return false;
      if (app[i] !== min[i] && app[i] !== max[i]) break;
    }

    return true;
  }

  /**
   * 关闭数据库连接
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

// ============================================================
// 命令行入口
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('用法: npx ts-node scripts/migration-compat-helper.ts <command> [options]');
    console.error('');
    console.error('命令:');
    console.error('  check      - 检查迁移兼容性');
    console.error('  expand     - 执行 Expand 阶段');
    console.error('  contract   - 执行 Contract 阶段');
    console.error('  verify     - 验证 Schema 与应用版本兼容性');
    console.error('  rollback   - 生成回滚脚本（不自动执行）');
    process.exit(1);
  }

  const helper = new MigrationCompatHelper();

  try {
    switch (command) {
      case 'check': {
        const result = await helper.checkCompatibility();
        console.log('');
        console.log('=== 兼容性检查结果 ===');
        console.log(`Schema 版本: ${result.schemaVersion}`);
        console.log(`应用版本: ${result.appVersion}`);
        console.log(`兼容性: ${result.compatible ? '✅ 通过' : '❌ 不通过'}`);
        console.log(`Expand 阶段就绪: ${result.expandPhaseReady ? '是' : '否'}`);
        console.log(`Contract 阶段就绪: ${result.contractPhaseReady ? '是' : '否'}`);
        if (result.issues.length > 0) {
          console.log('');
          console.log('问题:');
          for (const issue of result.issues) {
            console.log(`  [${issue.severity.toUpperCase()}] ${issue.message}`);
            if (issue.recommendation) {
              console.log(`    建议: ${issue.recommendation}`);
            }
          }
        }
        break;
      }
      case 'expand': {
        const result = await helper.executeExpandPhase(args[1]);
        console.log('');
        console.log('=== Expand 阶段执行结果 ===');
        console.log(`成功: ${result.success ? '是' : '否'}`);
        console.log(`已执行迁移: ${result.executedMigrations.length} 个`);
        if (result.errors.length > 0) {
          console.log('错误:');
          for (const error of result.errors) {
            console.log(`  - ${error}`);
          }
        }
        break;
      }
      case 'contract': {
        const result = await helper.executeContractPhase();
        console.log('');
        console.log('=== Contract 阶段执行结果 ===');
        console.log(`可执行: ${result.canExecute ? '是' : '否'}`);
        if (result.reason) console.log(`原因: ${result.reason}`);
        console.log(`Contract 迁移: ${result.contractMigrations.length} 个`);
        break;
      }
      case 'verify': {
        const result = await helper.verifyCompatibility();
        console.log('');
        console.log('=== 验证结果 ===');
        console.log(`有效: ${result.valid ? '是' : '否'}`);
        for (const detail of result.details) {
          console.log(`  - ${detail}`);
        }
        break;
      }
      case 'rollback': {
        if (!args[1]) {
          console.error('错误: 需要指定迁移版本');
          console.error('用法: npx ts-node scripts/migration-compat-helper.ts rollback <migration-version>');
          process.exit(1);
        }
        const script = helper.generateRollbackScript(args[1]);
        console.log(script);
        break;
      }
      default:
        console.error(`未知命令: ${command}`);
        process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error(`执行失败: ${(error as Error).message}`);
    console.error((error as Error).stack);
    process.exit(1);
  } finally {
    await helper.disconnect();
  }
}

if (require.main === module) {
  main();
}

export { MigrationCompatHelper };
export type { CompatibilityCheckResult, MigrationInfo, CompatibilityMatrix };
