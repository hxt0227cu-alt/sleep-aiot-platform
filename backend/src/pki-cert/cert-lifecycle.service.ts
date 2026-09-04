import { Injectable, Logger } from '@nestjs/common';
import { CertSignService } from './cert-sign.service';
import { CrlService, RevocationReason } from './crl-service.service';
import { CaManagerService } from './ca-manager.service';
import { AuditRecorderService } from '../unified-audit/audit-recorder.service';

/**
 * 证书生命周期管理
 *
 * 覆盖签发、轮换、吊销、过期提醒全流程。
 */
@Injectable()
export class CertLifecycleService {
  private readonly logger = new Logger(CertLifecycleService.name);

  /** 证书过期提醒阈值（天） */
  private readonly EXPIRY_WARNING_THRESHOLD_DAYS = 30;

  /** 证书过期紧急阈值（天） */
  private readonly EXPIRY_CRITICAL_THRESHOLD_DAYS = 7;

  constructor(
    private readonly certSignService: CertSignService,
    private readonly crlService: CrlService,
    private readonly caManager: CaManagerService,
    private readonly auditRecorder: AuditRecorderService,
  ) {}

  /**
   * 签发新证书
   */
  async issueCertificate(request: Parameters<CertSignService['signDeviceCertificate']>[0]) {
    return this.certSignService.signDeviceCertificate(request);
  }

  /**
   * 轮换证书
   *
   * 为设备签发新证书，旧证书在宽限期后吊销。
   */
  async rotateCertificate(
    deviceId: string,
    csr: string,
    oldSerialNumber: string,
    operatorId: string,
    tenantId?: string,
  ): Promise<{ newCertificate: Awaited<ReturnType<CertSignService['signDeviceCertificate']>>; oldCertRevocationDelayHours: number }> {
    this.logger.log(`证书轮换: device=${deviceId}, oldSerial=${oldSerialNumber}`);

    // 1. 签发新证书
    const newCertificate = await this.certSignService.signDeviceCertificate({
      csr,
      deviceId,
      tenantId,
    });

    // 2. 旧证书设置延迟吊销（24 小时宽限期，允许设备完成切换）
    const gracePeriodHours = 24;
    this.scheduleRevocation(oldSerialNumber, RevocationReason.SUPERSEDED, operatorId, gracePeriodHours);

    // 3. 记录审计
    await this.auditRecorder.record({
      eventType: 'pki_cert_rotate',
      action: 'rotate_certificate',
      resourceType: 'device',
      resourceId: deviceId,
      operatorId,
      tenantId,
      result: 'success',
      metadata: {
        oldSerialNumber,
        newSerialNumber: newCertificate.serialNumber,
        gracePeriodHours,
      },
    });

    return { newCertificate, oldCertRevocationDelayHours: gracePeriodHours };
  }

  /**
   * 吊销证书
   */
  async revokeCertificate(serialNumber: string, reason: RevocationReason, operatorId: string): Promise<void> {
    await this.crlService.revokeCertificate(serialNumber, reason, operatorId);
  }

  /**
   * 设备 RMA（返修/报废）时吊销证书
   */
  async revokeForRma(deviceId: string, serialNumber: string, operatorId: string): Promise<void> {
    this.logger.log(`设备 RMA 证书吊销: device=${deviceId}, serial=${serialNumber}`);
    await this.crlService.revokeCertificate(serialNumber, RevocationReason.DEVICE_RMA, operatorId);
  }

  /**
   * 设备退役时吊销证书
   */
  async revokeForDecommission(deviceId: string, serialNumber: string, operatorId: string): Promise<void> {
    this.logger.log(`设备退役证书吊销: device=${deviceId}, serial=${serialNumber}`);
    await this.crlService.revokeCertificate(serialNumber, RevocationReason.DEVICE_DECOMMISSIONED, operatorId);
  }

  /**
   * 检查证书过期状态
   */
  checkCertExpiry(notAfter: string): CertExpiryStatus {
    const expiryDate = new Date(notAfter);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry <= 0) {
      return { status: 'expired', daysUntilExpiry, actionRequired: true };
    }
    if (daysUntilExpiry <= this.EXPIRY_CRITICAL_THRESHOLD_DAYS) {
      return { status: 'critical', daysUntilExpiry, actionRequired: true };
    }
    if (daysUntilExpiry <= this.EXPIRY_WARNING_THRESHOLD_DAYS) {
      return { status: 'warning', daysUntilExpiry, actionRequired: true };
    }
    return { status: 'valid', daysUntilExpiry, actionRequired: false };
  }

  /**
   * 获取即将过期的证书列表（用于定时提醒）
   */
  async getExpiringCertificates(thresholdDays: number = 30): Promise<ExpiringCertificate[]> {
    // 实际实现应从数据库查询，这里返回空列表
    this.logger.debug(`查询 ${thresholdDays} 天内过期的证书`);
    return [];
  }

  /**
   * 触发证书过期提醒
   */
  async triggerExpiryReminders(): Promise<{ warned: number; critical: number }> {
    const expiring = await this.getExpiringCertificates(this.EXPIRY_WARNING_THRESHOLD_DAYS);
    let warned = 0;
    let critical = 0;

    for (const cert of expiring) {
      const status = this.checkCertExpiry(cert.notAfter);
      if (status.status === 'critical') {
        critical++;
        this.logger.error(`证书紧急过期提醒: device=${cert.deviceId}, serial=${cert.serialNumber}, 剩余 ${status.daysUntilExpiry} 天`);
      } else if (status.status === 'warning') {
        warned++;
        this.logger.warn(`证书过期提醒: device=${cert.deviceId}, serial=${cert.serialNumber}, 剩余 ${status.daysUntilExpiry} 天`);
      }
    }

    return { warned, critical };
  }

  /**
   * 调度延迟吊销
   */
  private scheduleRevocation(serialNumber: string, reason: RevocationReason, operatorId: string, delayHours: number): void {
    const delayMs = delayHours * 60 * 60 * 1000;
    setTimeout(() => {
      this.crlService.revokeCertificate(serialNumber, reason, operatorId).catch((err) => {
        this.logger.error(`延迟吊销失败: serial=${serialNumber}, error=${err.message}`);
      });
    }, delayMs);
    this.logger.log(`已调度延迟吊销: serial=${serialNumber}, delay=${delayHours}h`);
  }
}

/**
 * 证书过期状态
 */
export interface CertExpiryStatus {
  status: 'valid' | 'warning' | 'critical' | 'expired';
  daysUntilExpiry: number;
  actionRequired: boolean;
}

/**
 * 即将过期的证书
 */
export interface ExpiringCertificate {
  deviceId: string;
  serialNumber: string;
  notAfter: string;
  tenantId?: string;
}
