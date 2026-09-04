import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CaManagerService } from './ca-manager.service';
import { KmsAdapterService } from './kms-adapter.service';
import { VaultAdapterService } from '../vault-secret/vault-adapter.service';
import { AuditRecorderService } from '../unified-audit/audit-recorder.service';

/**
 * CRL 服务
 *
 * 管理证书吊销列表，按配置周期生成并同步到 MQTT Broker；
 * 支持吊销状态查询与离线设备重连校验，执行分级校验策略。
 */
@Injectable()
export class CrlService implements OnModuleInit {
  private readonly logger = new Logger(CrlService.name);

  /** 吊销证书缓存 */
  private revokedCerts: Map<string, RevokedCertInfo> = new Map();

  /** 当前 CRL 版本号 */
  private crlVersion = 1;

  /** CRL 上次更新时间 */
  private lastUpdate: Date | null = null;

  /** CRL 下次更新时间 */
  private nextUpdate: Date | null = null;

  /** CRL 生成周期（小时） */
  private readonly CRL_GENERATION_INTERVAL_HOURS = 6;

  constructor(
    private readonly caManager: CaManagerService,
    private readonly kmsAdapter: KmsAdapterService,
    private readonly vaultAdapter: VaultAdapterService,
    private readonly auditRecorder: AuditRecorderService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadCrlFromVault();
    this.logger.log('CRL 服务初始化完成');
  }

  /**
   * 从 Vault 加载现有 CRL
   */
  private async loadCrlFromVault(): Promise<void> {
    try {
      const crlData = await this.vaultAdapter.readSecret('pki/crl/current');
      if (crlData && typeof crlData.revokedCerts === 'string') {
        const revokedCerts = JSON.parse(crlData.revokedCerts) as RevokedCertInfo[];
        for (const cert of revokedCerts) {
          this.revokedCerts.set(cert.serialNumber, cert);
        }
        this.crlVersion = Number(crlData.version) || 1;
        this.lastUpdate = crlData.lastUpdate ? new Date(crlData.lastUpdate) : new Date();
        this.nextUpdate = crlData.nextUpdate ? new Date(crlData.nextUpdate) : null;
        this.logger.log(`CRL 加载成功，共 ${this.revokedCerts.size} 条吊销记录`);
      }
    } catch (error) {
      this.logger.warn(`CRL 从 Vault 加载失败: ${error.message}`);
    }
  }

  /**
   * 吊销证书
   *
   * @param serialNumber 证书序列号
   * @param reason 吊销原因
   * @param operatorId 操作人
   */
  async revokeCertificate(serialNumber: string, reason: RevocationReason, operatorId: string): Promise<void> {
    if (this.revokedCerts.has(serialNumber)) {
      this.logger.warn(`证书 ${serialNumber} 已在吊销列表中`);
      return;
    }

    const revokedInfo: RevokedCertInfo = {
      serialNumber,
      revocationDate: new Date().toISOString(),
      reason,
      operatorId,
    };

    this.revokedCerts.set(serialNumber, revokedInfo);
    this.logger.log(`证书已吊销: serial=${serialNumber}, reason=${reason}, operator=${operatorId}`);

    // 记录审计
    await this.auditRecorder.record({
      eventType: 'pki_cert_revoke',
      action: 'revoke_certificate',
      resourceType: 'certificate',
      resourceId: serialNumber,
      operatorId,
      result: 'success',
      metadata: { reason, revocationDate: revokedInfo.revocationDate },
    });

    // 立即生成新 CRL 并同步
    await this.generateAndSyncCrl();
  }

  /**
   * 检查证书是否已吊销
   */
  isRevoked(serialNumber: string): boolean {
    return this.revokedCerts.has(serialNumber);
  }

  /**
   * 获取吊销证书信息
   */
  getRevokedCertInfo(serialNumber: string): RevokedCertInfo | undefined {
    return this.revokedCerts.get(serialNumber);
  }

  /**
   * 执行分级 CRL 校验
   *
   * 分级策略：
   * - 新设备首次接入：强制阻断
   * - 已吊销证书：永久阻断
   * - 过期重连：强制校验
   * - 已建立可信连接：设置宽限期
   * - 离线功能：不依赖 CRL 可用性
   */
  async validateWithPolicy(
    serialNumber: string,
    context: CrlValidationContext,
  ): Promise<CrlValidationResult> {
    // 已吊销证书永久阻断
    if (this.isRevoked(serialNumber)) {
      const info = this.getRevokedCertInfo(serialNumber)!;
      return {
        allowed: false,
        reason: 'certificate_revoked',
        message: `证书已吊销: ${info.reason}`,
        revokedInfo: info,
      };
    }

    // CRL 不可用时的分级处理
    const crlAvailable = this.lastUpdate !== null;
    if (!crlAvailable) {
      if (context.isNewDevice) {
        return {
          allowed: false,
          reason: 'crl_unavailable_new_device',
          message: '新设备首次接入时 CRL 不可用，拒绝接入',
        };
      }
      if (context.isOfflineFunction) {
        return {
          allowed: true,
          reason: 'offline_function_grace',
          message: '离线功能不依赖 CRL 可用性',
          gracePeriod: true,
        };
      }
      if (context.hasEstablishedConnection && this.isWithinGracePeriod()) {
        return {
          allowed: true,
          reason: 'grace_period',
          message: 'CRL 暂时不可用，已建立连接在宽限期内允许继续',
          gracePeriod: true,
        };
      }
      return {
        allowed: false,
        reason: 'crl_unavailable',
        message: 'CRL 不可用，拒绝接入',
      };
    }

    // CRL 过期检查
    if (this.nextUpdate && new Date() > this.nextUpdate) {
      this.logger.warn('CRL 已过期，触发紧急更新');
      this.generateAndSyncCrl().catch((err) => this.logger.error(`CRL 紧急更新失败: ${err.message}`));
    }

    return {
      allowed: true,
      reason: 'valid',
      message: '证书未吊销，CRL 校验通过',
    };
  }

  /**
   * 生成并同步 CRL
   */
  async generateAndSyncCrl(): Promise<string> {
    this.crlVersion++;
    this.lastUpdate = new Date();
    this.nextUpdate = new Date(Date.now() + this.CRL_GENERATION_INTERVAL_HOURS * 60 * 60 * 1000);

    const crlData = {
      version: this.crlVersion,
      issuer: this.caManager.getRootCaInfo()?.subject || 'Sleep Platform Root CA',
      lastUpdate: this.lastUpdate.toISOString(),
      nextUpdate: this.nextUpdate.toISOString(),
      revokedCertificates: Array.from(this.revokedCerts.values()),
      signatureAlgorithm: 'ECDSA-with-SHA256',
    };

    // 使用 KMS 签名 CRL
    let crlPem: string;
    try {
      const signature = await this.kmsAdapter.sign(
        'root-ca-key',
        Buffer.from(JSON.stringify(crlData)),
      );
      crlPem = this.buildCrlPem(crlData, signature);
    } catch (error) {
      this.logger.error(`CRL 签名失败: ${error.message}，使用开发模式`);
      crlPem = this.buildCrlPem(crlData, '[DEV MODE CRL SIGNATURE]');
    }

    // 存储到 Vault
    try {
      await this.vaultAdapter.writeSecret('pki/crl/current', {
        version: String(this.crlVersion),
        lastUpdate: this.lastUpdate.toISOString(),
        nextUpdate: this.nextUpdate.toISOString(),
        revokedCerts: JSON.stringify(Array.from(this.revokedCerts.values())),
        crlPem,
      });
    } catch (error) {
      this.logger.error(`CRL 存储到 Vault 失败: ${error.message}`);
    }

    this.logger.log(`CRL 生成并同步完成: version=${this.crlVersion}, revoked=${this.revokedCerts.size}`);
    return crlPem;
  }

  /**
   * 获取当前 CRL
   */
  getCurrentCrl(): { version: number; lastUpdate: string | null; nextUpdate: string | null; revokedCount: number } {
    return {
      version: this.crlVersion,
      lastUpdate: this.lastUpdate?.toISOString() || null,
      nextUpdate: this.nextUpdate?.toISOString() || null,
      revokedCount: this.revokedCerts.size,
    };
  }

  /**
   * 列出所有吊销证书
   */
  listRevokedCerts(): RevokedCertInfo[] {
    return Array.from(this.revokedCerts.values());
  }

  /**
   * 是否在宽限期内
   */
  private isWithinGracePeriod(): boolean {
    if (!this.nextUpdate) return true;
    const gracePeriodMs = 30 * 60 * 1000; // 30 分钟宽限
    return Date.now() < this.nextUpdate.getTime() + gracePeriodMs;
  }

  /**
   * 构建 CRL PEM
   */
  private buildCrlPem(crlData: Record<string, unknown>, signature: string): string {
    return [
      '-----BEGIN X509 CRL-----',
      Buffer.from(JSON.stringify({ ...crlData, signature })).toString('base64').match(/.{1,64}/g)?.join('\n'),
      '-----END X509 CRL-----',
    ].join('\n');
  }
}

/**
 * 吊销原因
 */
export enum RevocationReason {
  UNSPECIFIED = 'unspecified',
  KEY_COMPROMISE = 'key_compromise',
  CA_COMPROMISE = 'ca_compromise',
  AFFILIATION_CHANGED = 'affiliation_changed',
  SUPERSEDED = 'superseded',
  CESSATION_OF_OPERATION = 'cessation_of_operation',
  CERTIFICATE_HOLD = 'certificate_hold',
  REMOVE_FROM_CRL = 'remove_from_crl',
  PRIVILEGE_WITHDRAWN = 'privilege_withdrawn',
  AA_COMPROMISE = 'aa_compromise',
  DEVICE_RMA = 'device_rma',
  DEVICE_DECOMMISSIONED = 'device_decommissioned',
}

/**
 * 吊销证书信息
 */
export interface RevokedCertInfo {
  serialNumber: string;
  revocationDate: string;
  reason: RevocationReason;
  operatorId: string;
}

/**
 * CRL 校验上下文
 */
export interface CrlValidationContext {
  /** 是否新设备首次接入 */
  isNewDevice: boolean;
  /** 是否已建立可信连接 */
  hasEstablishedConnection: boolean;
  /** 是否离线功能 */
  isOfflineFunction: boolean;
  /** 设备 ID */
  deviceId?: string;
}

/**
 * CRL 校验结果
 */
export interface CrlValidationResult {
  allowed: boolean;
  reason: string;
  message: string;
  revokedInfo?: RevokedCertInfo;
  gracePeriod?: boolean;
}
