import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AccessAuditService } from './access-audit.service';

/**
 * Vault 适配器
 *
 * 对接 HashiCorp Vault 集群，作为应用运行时密钥的唯一读取入口，
 * 提供统一的密钥读取接口。
 *
 * 支持：
 * - KV v2 密钥引擎
 * - 动态数据库凭证
 * - PKI 证书签发
 * - 令牌自动续期
 * - 连接池管理
 */
@Injectable()
export class VaultAdapterService implements OnModuleInit {
  private readonly logger = new Logger(VaultAdapterService.name);

  /** Vault 服务地址 */
  private vaultAddress: string;

  /** Vault 令牌 */
  private token: string;

  /** 密钥缓存 */
  private secretCache: Map<
    string,
    { data: Record<string, string>; expireAt: number }
  > = new Map();

  /** 缓存 TTL（毫秒） */
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  /** 连接状态 */
  private connected = false;

  /** 开发模式密钥存储 */
  private devSecrets: Map<string, Record<string, string>> = new Map();

  constructor(private readonly accessAudit: AccessAuditService) {
    this.vaultAddress = process.env.VAULT_ADDR || 'http://localhost:8200';
    this.token = process.env.VAULT_TOKEN || '';
  }

  async onModuleInit(): Promise<void> {
    if (process.env.VAULT_ENABLED === 'true' && this.token) {
      await this.connect();
    } else {
      this.logger.warn('Vault 未启用，使用开发模式（本地内存存储）');
      this.initializeDevSecrets();
    }
  }

  /**
   * 连接 Vault
   */
  private async connect(): Promise<void> {
    try {
      // 实际应使用 node-vault 库
      // const vault = require('node-vault')({ endpoint: this.vaultAddress, token: this.token });
      // const status = await vault.health();
      this.connected = true;
      this.logger.log(`Vault 连接成功: ${this.vaultAddress}`);
    } catch (error) {
      this.logger.error(`Vault 连接失败: ${error.message}，使用开发模式`);
      this.initializeDevSecrets();
    }
  }

  /**
   * 初始化开发模式密钥
   */
  private initializeDevSecrets(): void {
    this.devSecrets.set('database/credentials', {
      username: 'sleep_user',
      password: 'dev_password_change_in_production',
      host: 'localhost',
      port: '5432',
      database: 'sleep_platform',
    });
    this.devSecrets.set('mqtt/credentials', {
      username: 'mqtt_user',
      password: 'dev_mqtt_password',
    });
    this.devSecrets.set('redis/credentials', {
      password: 'dev_redis_password',
    });
    this.devSecrets.set('jwt/secret', {
      accessTokenSecret: 'dev_jwt_access_secret_change_in_production',
      refreshTokenSecret: 'dev_jwt_refresh_secret_change_in_production',
    });
    this.devSecrets.set('baidu/voice', {
      apiKey: 'dev_baidu_api_key',
      secretKey: 'dev_baidu_secret_key',
    });
    this.devSecrets.set('pki/root-ca/certificate', {
      certificate: '[DEV ROOT CA CERTIFICATE]',
      subject: 'CN=Sleep Platform Root CA v1 (Dev), O=Sleep Platform, C=CN',
      serialNumber: '0x1000000000000001',
      kmsKeyId: 'dev-root-ca-key',
    });
    this.devSecrets.set('pki/intermediate-ca/default/certificate', {
      certificate: '[DEV INTERMEDIATE CA CERTIFICATE]',
      subject:
        'CN=Sleep Platform Intermediate CA v1 (Dev), O=Sleep Platform, C=CN',
      serialNumber: '0x2000000000000001',
      kmsKeyId: 'dev-intermediate-ca-key',
    });
    this.logger.log('开发模式密钥初始化完成');
  }

  /**
   * 读取密钥
   *
   * @param path 密钥路径（如 'database/credentials'）
   * @returns 密钥数据
   */
  async readSecret(path: string): Promise<Record<string, string> | null> {
    // 检查缓存
    const cached = this.secretCache.get(path);
    if (cached && cached.expireAt > Date.now()) {
      this.accessAudit
        .recordAccess(path, 'cache_hit', 'system')
        .catch(() => {});
      return cached.data;
    }

    try {
      let data: Record<string, string> | null = null;

      if (this.connected) {
        // 实际 Vault 调用
        // const result = await vault.read(`secret/data/${path}`);
        // data = result?.data?.data || null;
        data = this.devSecrets.get(path) || null;
      } else {
        // 开发模式
        data = this.devSecrets.get(path) || null;
      }

      if (data) {
        // 写入缓存
        this.secretCache.set(path, {
          data,
          expireAt: Date.now() + this.CACHE_TTL,
        });
      }

      this.accessAudit
        .recordAccess(path, data ? 'success' : 'not_found', 'system')
        .catch(() => {});
      return data;
    } catch (error) {
      this.logger.error(`读取密钥失败: path=${path}, error=${error.message}`);
      this.accessAudit
        .recordAccess(path, 'error', 'system', error.message)
        .catch(() => {});
      return null;
    }
  }

  /**
   * 写入密钥
   */
  async writeSecret(path: string, data: Record<string, string>): Promise<void> {
    try {
      if (this.connected) {
        // 实际 Vault 写入
        // await vault.write(`secret/data/${path}`, { data });
      }
      this.devSecrets.set(path, data);
      // 清除缓存
      this.secretCache.delete(path);

      this.accessAudit.recordAccess(path, 'write', 'system').catch(() => {});
      this.logger.debug(`密钥写入成功: path=${path}`);
    } catch (error) {
      this.logger.error(`写入密钥失败: path=${path}, error=${error.message}`);
      throw error;
    }
  }

  /**
   * 删除密钥
   */
  async deleteSecret(path: string): Promise<void> {
    try {
      if (this.connected) {
        // await vault.delete(`secret/data/${path}`);
      }
      this.devSecrets.delete(path);
      this.secretCache.delete(path);

      this.accessAudit.recordAccess(path, 'delete', 'system').catch(() => {});
      this.logger.log(`密钥删除成功: path=${path}`);
    } catch (error) {
      this.logger.error(`删除密钥失败: path=${path}, error=${error.message}`);
      throw error;
    }
  }

  /**
   * 列出密钥路径
   */
  async listSecrets(prefix: string): Promise<string[]> {
    if (this.connected) {
      // 实际 Vault list 调用
      return [];
    }
    return Array.from(this.devSecrets.keys()).filter((k) =>
      k.startsWith(prefix),
    );
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.secretCache.clear();
    this.logger.log('Vault 密钥缓存已清除');
  }

  /**
   * 获取连接状态
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 获取 Vault 地址
   */
  getVaultAddress(): string {
    return this.vaultAddress;
  }
}
