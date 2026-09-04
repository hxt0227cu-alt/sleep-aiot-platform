import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KmsAdapterService } from './kms-adapter.service';
import { VaultAdapterService } from '../vault-secret/vault-adapter.service';

/**
 * CA 管理器
 *
 * 维护离线根 CA + 在线中间 CA 分层结构：
 * - 根 CA 无在线调用接口，仅用于离线签发中间 CA
 * - 中间 CA 提供日常设备证书签发服务
 * - 普通租户共用中间 CA，高合规租户可选独立 CA
 */
@Injectable()
export class CaManagerService implements OnModuleInit {
  private readonly logger = new Logger(CaManagerService.name);

  /** 根 CA 信息（仅元数据，无私钥） */
  private rootCaInfo: CaInfo | null = null;

  /** 中间 CA 缓存 */
  private intermediateCaCache: Map<string, CaInfo> = new Map();

  /** 默认中间 CA ID */
  private readonly DEFAULT_INTERMEDIATE_CA_ID = 'intermediate-ca-v1-default';

  constructor(
    private readonly kmsAdapter: KmsAdapterService,
    private readonly vaultAdapter: VaultAdapterService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadRootCaInfo();
    await this.loadDefaultIntermediateCa();
    this.logger.log('CA 管理器初始化完成');
  }

  /**
   * 加载根 CA 元数据（从 Vault 读取，根 CA 私钥在 KMS 中，不导出）
   */
  private async loadRootCaInfo(): Promise<void> {
    try {
      const rootCaCert = await this.vaultAdapter.readSecret(
        'pki/root-ca/certificate',
      );
      if (rootCaCert) {
        this.rootCaInfo = {
          caId: 'root-ca-v1',
          certPem: rootCaCert.certificate,
          subject:
            rootCaCert.subject ||
            'CN=Sleep Platform Root CA v1, O=Sleep Platform, C=CN',
          serialNumber: rootCaCert.serialNumber || '0x1000000000000001',
          notBefore: rootCaCert.notBefore,
          notAfter: rootCaCert.notAfter,
          keyType: 'ECDSA-P256',
          isRoot: true,
          kmsKeyId: rootCaCert.kmsKeyId,
        };
        this.logger.log(
          `根 CA 元数据加载成功: serial=${this.rootCaInfo.serialNumber}`,
        );
      } else {
        this.logger.warn(
          '根 CA 证书未在 Vault 中找到，使用默认配置（开发模式）',
        );
        this.rootCaInfo = this.getDefaultRootCaInfo();
      }
    } catch (error) {
      this.logger.error(`根 CA 加载失败: ${error.message}，使用默认配置`);
      this.rootCaInfo = this.getDefaultRootCaInfo();
    }
  }

  /**
   * 加载默认中间 CA
   */
  private async loadDefaultIntermediateCa(): Promise<void> {
    try {
      const intermediateCert = await this.vaultAdapter.readSecret(
        'pki/intermediate-ca/default/certificate',
      );
      if (intermediateCert) {
        const caInfo: CaInfo = {
          caId: this.DEFAULT_INTERMEDIATE_CA_ID,
          certPem: intermediateCert.certificate,
          subject:
            intermediateCert.subject ||
            'CN=Sleep Platform Intermediate CA v1, O=Sleep Platform, C=CN',
          serialNumber: intermediateCert.serialNumber || '0x2000000000000001',
          notBefore: intermediateCert.notBefore,
          notAfter: intermediateCert.notAfter,
          keyType: 'ECDSA-P256',
          isRoot: false,
          parentCaId: 'root-ca-v1',
          kmsKeyId: intermediateCert.kmsKeyId,
        };
        this.intermediateCaCache.set(this.DEFAULT_INTERMEDIATE_CA_ID, caInfo);
        this.logger.log(`默认中间 CA 加载成功: serial=${caInfo.serialNumber}`);
      } else {
        this.logger.warn('默认中间 CA 证书未找到，使用默认配置（开发模式）');
        this.intermediateCaCache.set(
          this.DEFAULT_INTERMEDIATE_CA_ID,
          this.getDefaultIntermediateCaInfo(),
        );
      }
    } catch (error) {
      this.logger.error(`默认中间 CA 加载失败: ${error.message}`);
      this.intermediateCaCache.set(
        this.DEFAULT_INTERMEDIATE_CA_ID,
        this.getDefaultIntermediateCaInfo(),
      );
    }
  }

  /**
   * 获取根 CA 信息
   */
  getRootCaInfo(): CaInfo | null {
    return this.rootCaInfo;
  }

  /**
   * 获取指定租户的中间 CA
   *
   * 普通租户使用默认中间 CA，高合规租户可选独立 CA。
   */
  async getIntermediateCa(tenantId?: string): Promise<CaInfo> {
    // 高合规租户使用独立 CA
    if (tenantId) {
      const tenantCaId = `intermediate-ca-tenant-${tenantId}`;
      if (this.intermediateCaCache.has(tenantCaId)) {
        return this.intermediateCaCache.get(tenantCaId)!;
      }

      // 尝试从 Vault 加载租户独立 CA
      try {
        const tenantCert = await this.vaultAdapter.readSecret(
          `pki/intermediate-ca/tenant-${tenantId}/certificate`,
        );
        if (tenantCert) {
          const caInfo: CaInfo = {
            caId: tenantCaId,
            certPem: tenantCert.certificate,
            subject: tenantCert.subject,
            serialNumber: tenantCert.serialNumber,
            notBefore: tenantCert.notBefore,
            notAfter: tenantCert.notAfter,
            keyType: 'ECDSA-P256',
            isRoot: false,
            parentCaId: 'root-ca-v1',
            kmsKeyId: tenantCert.kmsKeyId,
          };
          this.intermediateCaCache.set(tenantCaId, caInfo);
          this.logger.log(`租户 ${tenantId} 独立中间 CA 加载成功`);
          return caInfo;
        }
      } catch (error) {
        this.logger.debug(
          `租户 ${tenantId} 无独立 CA，使用默认 CA: ${error.message}`,
        );
      }
    }

    // 使用默认中间 CA
    return this.intermediateCaCache.get(this.DEFAULT_INTERMEDIATE_CA_ID)!;
  }

  /**
   * 获取证书链（根 CA + 中间 CA）
   */
  async getCertChain(tenantId?: string): Promise<string> {
    const intermediate = await this.getIntermediateCa(tenantId);
    const root = this.rootCaInfo;
    return [intermediate.certPem, root?.certPem].filter(Boolean).join('\n');
  }

  /**
   * 验证 CA 证书有效性
   */
  validateCaExpiry(caInfo: CaInfo): {
    valid: boolean;
    daysUntilExpiry: number;
  } {
    if (!caInfo.notAfter) {
      return { valid: true, daysUntilExpiry: -1 };
    }
    const expiry = new Date(caInfo.notAfter).getTime();
    const now = Date.now();
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    return { valid: daysUntilExpiry > 0, daysUntilExpiry };
  }

  /**
   * 列出所有中间 CA
   */
  listIntermediateCas(): CaInfo[] {
    return Array.from(this.intermediateCaCache.values());
  }

  /**
   * 默认根 CA 信息（开发模式）
   */
  private getDefaultRootCaInfo(): CaInfo {
    return {
      caId: 'root-ca-v1',
      certPem:
        '-----BEGIN CERTIFICATE-----\n[DEV MODE] Root CA placeholder\n-----END CERTIFICATE-----',
      subject: 'CN=Sleep Platform Root CA v1 (Dev), O=Sleep Platform, C=CN',
      serialNumber: '0x1000000000000001',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2036-01-01T00:00:00Z',
      keyType: 'ECDSA-P256',
      isRoot: true,
      kmsKeyId: 'dev-root-ca-key',
    };
  }

  /**
   * 默认中间 CA 信息（开发模式）
   */
  private getDefaultIntermediateCaInfo(): CaInfo {
    return {
      caId: this.DEFAULT_INTERMEDIATE_CA_ID,
      certPem:
        '-----BEGIN CERTIFICATE-----\n[DEV MODE] Intermediate CA placeholder\n-----END CERTIFICATE-----',
      subject:
        'CN=Sleep Platform Intermediate CA v1 (Dev), O=Sleep Platform, C=CN',
      serialNumber: '0x2000000000000001',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2031-01-01T00:00:00Z',
      keyType: 'ECDSA-P256',
      isRoot: false,
      parentCaId: 'root-ca-v1',
      kmsKeyId: 'dev-intermediate-ca-key',
    };
  }
}

/**
 * CA 信息
 */
export interface CaInfo {
  caId: string;
  certPem: string;
  subject: string;
  serialNumber: string;
  notBefore?: string;
  notAfter?: string;
  keyType: string;
  isRoot: boolean;
  parentCaId?: string;
  kmsKeyId?: string;
}
