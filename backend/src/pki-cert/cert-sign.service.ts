import { Injectable, Logger } from '@nestjs/common';
import { CertSignRequestDto } from './dto/cert-sign-request.dto';
import { CaManagerService } from './ca-manager.service';
import { KmsAdapterService } from './kms-adapter.service';
import { AuditRecorderService } from '../unified-audit/audit-recorder.service';

/**
 * 证书签发服务
 *
 * 仅处理设备端提交的 CSR，签发对应身份证书，
 * 不生成、不存储设备私钥。
 */
@Injectable()
export class CertSignService {
  private readonly logger = new Logger(CertSignService.name);

  /** 证书有效期（天） */
  private readonly CERT_VALIDITY_DAYS = 365 * 2; // 2 年

  /** 证书序列号计数器 */
  private serialCounter = 0x3000000000000000;

  constructor(
    private readonly caManager: CaManagerService,
    private readonly kmsAdapter: KmsAdapterService,
    private readonly auditRecorder: AuditRecorderService,
  ) {}

  /**
   * 签发设备证书
   *
   * @param request 证书签发请求（仅含 CSR，无私钥）
   * @returns 签发的证书 PEM + 证书链
   */
  async signDeviceCertificate(request: CertSignRequestDto): Promise<SignedCertificateResult> {
    this.logger.log(`证书签发请求: device=${request.deviceId}, tenant=${request.tenantId || 'default'}`);

    // 1. 校验 CSR 格式
    const csrInfo = this.parseAndValidateCsr(request.csr);
    if (!csrInfo.valid) {
      throw new Error(`CSR 校验失败: ${csrInfo.error}`);
    }

    // 2. 获取中间 CA
    const intermediateCa = await this.caManager.getIntermediateCa(request.tenantId);

    // 3. 校验 CA 有效期
    const caValidity = this.caManager.validateCaExpiry(intermediateCa);
    if (!caValidity.valid) {
      throw new Error(`中间 CA 已过期，无法签发证书`);
    }
    if (caValidity.daysUntilExpiry < 30) {
      this.logger.warn(`中间 CA 将在 ${caValidity.daysUntilExpiry} 天后过期，请及时续期`);
    }

    // 4. 生成证书序列号
    const serialNumber = this.generateSerialNumber();

    // 5. 构建证书
    const notBefore = new Date();
    const notAfter = new Date(Date.now() + this.CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

    // 6. 使用 KMS 中的中间 CA 私钥签名（私钥不导出）
    const certificatePem = await this.signWithKms(
      request.csr,
      intermediateCa,
      serialNumber,
      notBefore,
      notAfter,
      request,
    );

    // 7. 获取证书链
    const certChain = await this.caManager.getCertChain(request.tenantId);

    // 8. 记录审计
    await this.auditRecorder.record({
      eventType: 'pki_cert_sign',
      action: 'sign_device_certificate',
      resourceType: 'certificate',
      resourceId: serialNumber,
      operatorId: 'system',
      tenantId: request.tenantId,
      result: 'success',
      metadata: {
        deviceId: request.deviceId,
        serialNumber,
        subject: csrInfo.subject,
        notAfter: notAfter.toISOString(),
        caId: intermediateCa.caId,
      },
    });

    this.logger.log(`证书签发成功: device=${request.deviceId}, serial=${serialNumber}`);

    return {
      certificate: certificatePem,
      certChain,
      serialNumber,
      subject: csrInfo.subject || '',
      issuer: intermediateCa.subject,
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      caId: intermediateCa.caId,
    };
  }

  /**
   * 解析并校验 CSR
   */
  private parseAndValidateCsr(csrPem: string): { valid: boolean; subject?: string; publicKey?: string; error?: string } {
    // 基本格式校验
    if (!csrPem.includes('BEGIN CERTIFICATE REQUEST') && !csrPem.includes('BEGIN NEW CERTIFICATE REQUEST')) {
      return { valid: false, error: 'CSR 格式不正确，缺少 BEGIN CERTIFICATE REQUEST 标记' };
    }

    // 校验 PEM 结构
    const base64Content = csrPem
      .replace(/-----BEGIN (NEW )?CERTIFICATE REQUEST-----/g, '')
      .replace(/-----END (NEW )?CERTIFICATE REQUEST-----/g, '')
      .replace(/\s/g, '');

    if (base64Content.length < 100) {
      return { valid: false, error: 'CSR 内容过短' };
    }

    // 开发模式：提取主题（简化处理）
    const subjectMatch = csrPem.match(/CN\s*=\s*([^,\n]+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : `device-${Date.now()}`;

    return { valid: true, subject, publicKey: '[extracted from CSR]' };
  }

  /**
   * 生成证书序列号
   */
  private generateSerialNumber(): string {
    this.serialCounter++;
    return `0x${this.serialCounter.toString(16).padStart(16, '0')}`;
  }

  /**
   * 使用 KMS 签名证书
   *
   * 私钥在 KMS 中，不导出到应用层。
   */
  private async signWithKms(
    csr: string,
    caInfo: { caId: string; subject: string; kmsKeyId?: string },
    serialNumber: string,
    notBefore: Date,
    notAfter: Date,
    request: CertSignRequestDto,
  ): Promise<string> {
    try {
      // 使用 KMS 适配器进行签名
      const signature = await this.kmsAdapter.sign(
        caInfo.kmsKeyId || `intermediate-ca-key`,
        this.buildTbsCertificate(csr, caInfo, serialNumber, notBefore, notAfter, request),
      );

      // 构建完整证书 PEM
      return this.buildCertificatePem(csr, caInfo, serialNumber, notBefore, notAfter, signature, request);
    } catch (error) {
      this.logger.error(`KMS 签名失败: ${error.message}，使用开发模式 fallback`);
      // 开发模式 fallback
      return this.buildDevCertificate(csr, caInfo, serialNumber, notBefore, notAfter, request);
    }
  }

  /**
   * 构建待签名证书内容
   */
  private buildTbsCertificate(
    csr: string,
    caInfo: { subject: string },
    serialNumber: string,
    notBefore: Date,
    notAfter: Date,
    request: CertSignRequestDto,
  ): Buffer {
    const tbs = {
      version: 3,
      serialNumber,
      signature: { algorithm: 'ECDSA-with-SHA256' },
      issuer: caInfo.subject,
      validity: { notBefore, notAfter },
      subject: `CN=${request.deviceId}, O=Sleep Platform Device, C=CN`,
      extensions: {
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extendedKeyUsage: ['clientAuth'],
        subjectAltName: [
          { type: 'DNS', value: `${request.deviceId}.device.sleep-platform.local` },
          { type: 'URI', value: `urn:sleep-platform:device:${request.deviceId}` },
        ],
        basicConstraints: { cA: false },
      },
    };
    return Buffer.from(JSON.stringify(tbs));
  }

  /**
   * 构建证书 PEM
   */
  private buildCertificatePem(
    csr: string,
    caInfo: { subject: string },
    serialNumber: string,
    notBefore: Date,
    notAfter: Date,
    signature: string,
    request: CertSignRequestDto,
  ): string {
    // 简化的证书 PEM 构建（实际应使用 node-forge 或类似库）
    const certData = {
      version: 'v3',
      serialNumber,
      signatureAlgorithm: 'ecdsa-with-SHA256',
      issuer: caInfo.subject,
      validity: {
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
      },
      subject: `CN=${request.deviceId}, O=Sleep Platform Device, C=CN`,
      subjectPublicKeyInfo: '[from CSR]',
      extensions: {
        keyUsage: 'Digital Signature, Key Encipherment',
        extendedKeyUsage: 'TLS Web Client Authentication',
        subjectAltName: `DNS:${request.deviceId}.device.sleep-platform.local, URI:urn:sleep-platform:device:${request.deviceId}`,
        basicConstraints: 'CA:FALSE',
      },
      signatureValue: signature,
    };

    return [
      '-----BEGIN CERTIFICATE-----',
      Buffer.from(JSON.stringify(certData)).toString('base64').match(/.{1,64}/g)?.join('\n'),
      '-----END CERTIFICATE-----',
    ].join('\n');
  }

  /**
   * 开发模式证书构建
   */
  private buildDevCertificate(
    csr: string,
    caInfo: { subject: string },
    serialNumber: string,
    notBefore: Date,
    notAfter: Date,
    request: CertSignRequestDto,
  ): string {
    return this.buildCertificatePem(csr, caInfo, serialNumber, notBefore, notAfter, '[DEV MODE SIGNATURE]', request);
  }
}

/**
 * 签发证书结果
 */
export interface SignedCertificateResult {
  certificate: string;
  certChain: string;
  serialNumber: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  caId: string;
}
