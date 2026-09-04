import { Injectable, Logger } from '@nestjs/common';
import { PkiCertModule } from '../pki-cert/pki-cert.module';
import { CrlService } from '../pki-cert/crl-service.service';
import { CaManagerService } from '../pki-cert/ca-manager.service';

/**
 * 设备证书服务
 *
 * 对接 PKI 模块实现设备证书状态查询、吊销触发、轮换提醒。
 */
@Injectable()
export class DeviceCertService {
  private readonly logger = new Logger(DeviceCertService.name);

  constructor(
    private readonly crlService: CrlService,
    private readonly caManager: CaManagerService,
  ) {}

  /**
   * 查询设备证书状态
   *
   * @param deviceId 设备 ID
   * @param serialNumber 证书序列号
   * @returns 证书状态
   */
  async getCertStatus(deviceId: string, serialNumber: string): Promise<DeviceCertStatus> {
    // 检查是否已吊销
    const isRevoked = this.crlService.isRevoked(serialNumber);
    const revokedInfo = this.crlService.getRevokedCertInfo(serialNumber);

    // 获取 CA 信息
    const rootCa = this.caManager.getRootCaInfo();
    const intermediateCa = await this.caManager.getIntermediateCa();

    return {
      deviceId,
      serialNumber,
      status: isRevoked ? 'revoked' : 'valid',
      revokedAt: revokedInfo?.revocationDate,
      revocationReason: revokedInfo?.reason,
      issuer: intermediateCa.subject,
      rootCaSubject: rootCa?.subject,
      valid: !isRevoked,
    };
  }

  /**
   * 吊销设备证书
   *
   * @param deviceId 设备 ID
   * @param serialNumber 证书序列号
   * @param reason 吊销原因
   * @param operatorId 操作人
   */
  async revokeCert(deviceId: string, serialNumber: string, reason: string, operatorId: string): Promise<void> {
    this.logger.log(`设备证书吊销: device=${deviceId}, serial=${serialNumber}, reason=${reason}, operator=${operatorId}`);

    // 映射吊销原因
    const crlReason = this.mapRevocationReason(reason);
    await this.crlService.revokeCertificate(serialNumber, crlReason, operatorId);
  }

  /**
   * 设备 RMA（返修）时吊销证书
   */
  async revokeForRma(deviceId: string, serialNumber: string, operatorId: string): Promise<void> {
    this.logger.log(`设备 RMA 证书吊销: device=${deviceId}, serial=${serialNumber}`);
    await this.crlService.revokeCertificate(serialNumber, 'device_rma' as never, operatorId);
  }

  /**
   * 设备退役时吊销证书
   */
  async revokeForDecommission(deviceId: string, serialNumber: string, operatorId: string): Promise<void> {
    this.logger.log(`设备退役证书吊销: device=${deviceId}, serial=${serialNumber}`);
    await this.crlService.revokeCertificate(serialNumber, 'device_decommissioned' as never, operatorId);
  }

  /**
   * 验证设备证书（接入时调用）
   *
   * 执行分级 CRL 校验策略。
   */
  async validateCertForConnection(
    deviceId: string,
    serialNumber: string,
    context: { isNewDevice: boolean; hasEstablishedConnection: boolean; isOfflineFunction: boolean },
  ): Promise<{ allowed: boolean; reason: string; gracePeriod?: boolean }> {
    const result = await this.crlService.validateWithPolicy(serialNumber, context);

    if (!result.allowed) {
      this.logger.warn(`设备证书校验拒绝: device=${deviceId}, serial=${serialNumber}, reason=${result.reason}`);
    }

    return {
      allowed: result.allowed,
      reason: result.message,
      gracePeriod: result.gracePeriod,
    };
  }

  /**
   * 获取证书链
   */
  async getCertChain(tenantId?: string): Promise<string> {
    return this.caManager.getCertChain(tenantId);
  }

  /**
   * 检查证书过期状态
   */
  checkCertExpiry(notAfter: string): { status: string; daysUntilExpiry: number; actionRequired: boolean } {
    const expiryDate = new Date(notAfter);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry <= 0) {
      return { status: 'expired', daysUntilExpiry, actionRequired: true };
    }
    if (daysUntilExpiry <= 7) {
      return { status: 'critical', daysUntilExpiry, actionRequired: true };
    }
    if (daysUntilExpiry <= 30) {
      return { status: 'warning', daysUntilExpiry, actionRequired: true };
    }
    return { status: 'valid', daysUntilExpiry, actionRequired: false };
  }

  /**
   * 映射吊销原因到 CRL 标准原因
   */
  private mapRevocationReason(reason: string): never {
    const reasonMap: Record<string, string> = {
      'key_compromise': 'key_compromise',
      'device_lost': 'key_compromise',
      'device_stolen': 'key_compromise',
      'rma': 'device_rma',
      'decommissioned': 'device_decommissioned',
      'superseded': 'superseded',
      'rotated': 'superseded',
      'security_breach': 'key_compromise',
      'fraud': 'privilege_withdrawn',
    };
    return (reasonMap[reason.toLowerCase()] || 'unspecified') as never;
  }
}

/**
 * 设备证书状态
 */
export interface DeviceCertStatus {
  deviceId: string;
  serialNumber: string;
  status: 'valid' | 'revoked' | 'expired';
  revokedAt?: string;
  revocationReason?: string;
  issuer: string;
  rootCaSubject?: string;
  valid: boolean;
}
