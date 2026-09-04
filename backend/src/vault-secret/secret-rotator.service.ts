import { Injectable, Logger } from '@nestjs/common';
import { VaultAdapterService } from './vault-adapter.service';
import { AccessAuditService } from './access-audit.service';

/**
 * 密钥轮换服务
 *
 * 定期轮换数据库、MQTT、API 等系统密钥；
 * 轮换操作全量审计。
 */
@Injectable()
export class SecretRotatorService {
  private readonly logger = new Logger(SecretRotatorService.name);

  /** 轮换周期（天） */
  private readonly ROTATION_PERIOD_DAYS = 90;

  /** 轮换提前提醒（天） */
  private readonly ROTATION_WARNING_DAYS = 7;

  constructor(
    private readonly vaultAdapter: VaultAdapterService,
    private readonly accessAudit: AccessAuditService,
  ) {}

  /**
   * 轮换指定密钥
   *
   * @param secretPath 密钥路径
   * @param newSecretData 新密钥数据
   * @param operatorId 操作人
   */
  async rotateSecret(
    secretPath: string,
    newSecretData: Record<string, string>,
    operatorId: string,
  ): Promise<SecretRotationResult> {
    this.logger.log(`密钥轮换开始: path=${secretPath}, operator=${operatorId}`);

    const startTime = Date.now();

    try {
      // 1. 读取旧密钥（用于回滚）
      const oldSecret = await this.vaultAdapter.readSecret(secretPath);

      // 2. 验证新密钥格式
      this.validateSecretData(secretPath, newSecretData);

      // 3. 写入新密钥
      await this.vaultAdapter.writeSecret(secretPath, newSecretData);

      // 4. 清除缓存
      this.vaultAdapter.clearCache();

      // 5. 记录审计
      await this.accessAudit.recordAccess(
        secretPath,
        'rotate',
        operatorId,
        JSON.stringify({
          oldKeys: oldSecret ? Object.keys(oldSecret) : [],
          newKeys: Object.keys(newSecretData),
          rotatedAt: new Date().toISOString(),
        }),
      );

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `密钥轮换成功: path=${secretPath}, duration=${durationMs}ms`,
      );

      return {
        success: true,
        secretPath,
        rotatedAt: new Date().toISOString(),
        operatorId,
        durationMs,
        oldSecretBackup: oldSecret, // 用于回滚
      };
    } catch (error) {
      this.logger.error(
        `密钥轮换失败: path=${secretPath}, error=${error.message}`,
      );

      await this.accessAudit
        .recordAccess(secretPath, 'rotate_failed', operatorId, error.message)
        .catch(() => {});

      return {
        success: false,
        secretPath,
        rotatedAt: new Date().toISOString(),
        operatorId,
        durationMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 回滚密钥
   */
  async rollbackSecret(
    secretPath: string,
    oldSecretData: Record<string, string>,
    operatorId: string,
  ): Promise<boolean> {
    try {
      this.logger.warn(`密钥回滚: path=${secretPath}, operator=${operatorId}`);
      await this.vaultAdapter.writeSecret(secretPath, oldSecretData);
      this.vaultAdapter.clearCache();

      await this.accessAudit
        .recordAccess(secretPath, 'rollback', operatorId)
        .catch(() => {});
      return true;
    } catch (error) {
      this.logger.error(
        `密钥回滚失败: path=${secretPath}, error=${error.message}`,
      );
      return false;
    }
  }

  /**
   * 检查密钥是否需要轮换
   */
  checkRotationNeeded(lastRotatedAt: string): {
    needed: boolean;
    daysSinceRotation: number;
    warning: boolean;
  } {
    const lastRotated = new Date(lastRotatedAt);
    const daysSinceRotation = Math.ceil(
      (Date.now() - lastRotated.getTime()) / (1000 * 60 * 60 * 24),
    );
    const needed = daysSinceRotation >= this.ROTATION_PERIOD_DAYS;
    const warning =
      daysSinceRotation >=
      this.ROTATION_PERIOD_DAYS - this.ROTATION_WARNING_DAYS;

    return { needed, daysSinceRotation, warning };
  }

  /**
   * 获取需要轮换的密钥列表
   */
  async getSecretsNeedingRotation(): Promise<string[]> {
    // 实际实现应从数据库查询密钥轮换记录
    this.logger.debug('查询需要轮换的密钥');
    return [];
  }

  /**
   * 执行批量轮换检查
   */
  async runRotationCheck(): Promise<{
    needingRotation: string[];
    warnings: string[];
  }> {
    const needingRotation: string[] = [];
    const warnings: string[] = [];

    const secrets = await this.getSecretsNeedingRotation();
    for (const path of secrets) {
      // 检查轮换状态
      needingRotation.push(path);
    }

    if (needingRotation.length > 0) {
      this.logger.warn(`发现 ${needingRotation.length} 个密钥需要轮换`);
    }

    return { needingRotation, warnings };
  }

  /**
   * 生成随机密码
   */
  generatePassword(length: number = 32): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * 验证密钥数据
   */
  private validateSecretData(path: string, data: Record<string, string>): void {
    if (!data || Object.keys(data).length === 0) {
      throw new Error('密钥数据不能为空');
    }

    // 针对特定路径的校验
    if (path.includes('database')) {
      if (!data.username || !data.password) {
        throw new Error('数据库密钥必须包含 username 和 password');
      }
    }
    if (path.includes('jwt')) {
      if (!data.accessTokenSecret || data.accessTokenSecret.length < 32) {
        throw new Error('JWT accessTokenSecret 长度至少 32 位');
      }
    }
  }
}

/**
 * 密钥轮换结果
 */
export interface SecretRotationResult {
  success: boolean;
  secretPath: string;
  rotatedAt: string;
  operatorId: string;
  durationMs: number;
  oldSecretBackup?: Record<string, string> | null;
  error?: string;
}
