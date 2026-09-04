import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * 固件签名校验服务
 *
 * 验证设备端升级包的数字签名合法性，
 * 对接离线签名工具的公钥验签逻辑。
 */
@Injectable()
export class FirmwareSignService {
  private readonly logger = new Logger(FirmwareSignService.name);

  /** 签名算法 */
  private readonly SIGN_ALGORITHM = 'ECDSA-SHA256';

  /** 固件签名公钥（生产环境应从 KMS/Vault 获取） */
  private signingPublicKey: string | null = null;

  /** 已验证的固件版本缓存 */
  private verifiedFirmwares: Map<string, VerifiedFirmwareInfo> = new Map();

  constructor() {
    this.loadPublicKey();
  }

  /**
   * 加载签名公钥
   */
  private loadPublicKey(): void {
    // 生产环境从 Vault 读取
    // const secret = await vaultAdapter.readSecret('firmware/signing/public-key');
    // this.signingPublicKey = secret.publicKey;

    // 开发模式使用内置公钥（实际应替换为真实公钥）
    this.signingPublicKey = process.env.FIRMWARE_SIGNING_PUBLIC_KEY || null;

    if (!this.signingPublicKey) {
      this.logger.warn('固件签名公钥未配置，使用开发模式（签名验证将使用哈希校验）');
    } else {
      this.logger.log('固件签名公钥加载成功');
    }
  }

  /**
   * 验证固件签名
   *
   * @param firmwareData 固件二进制数据
   * @param signature Base64 编码的签名
   * @param firmwareVersion 固件版本号
   * @returns 验证结果
   */
  verifySignature(firmwareData: Buffer, signature: string, firmwareVersion: string): FirmwareVerificationResult {
    this.logger.debug(`固件签名验证: version=${firmwareVersion}, dataSize=${firmwareData.length}`);

    const startTime = Date.now();

    try {
      // 1. 计算固件哈希
      const firmwareHash = crypto.createHash('sha256').update(firmwareData).digest('hex');

      // 2. 验证签名
      let signatureValid: boolean;
      if (this.signingPublicKey) {
        // 使用公钥验签
        const verify = crypto.createVerify('SHA256');
        verify.update(firmwareData);
        verify.end();
        signatureValid = verify.verify(this.signingPublicKey, Buffer.from(signature, 'base64'));
      } else {
        // 开发模式：仅验证签名格式和哈希匹配
        signatureValid = this.devModeVerify(firmwareHash, signature);
      }

      if (!signatureValid) {
        this.logger.error(`固件签名验证失败: version=${firmwareVersion}`);
        return {
          valid: false,
          firmwareVersion,
          firmwareHash,
          signatureAlgorithm: this.SIGN_ALGORITHM,
          error: '签名验证失败',
          verifiedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        };
      }

      // 3. 缓存验证结果
      const verifiedInfo: VerifiedFirmwareInfo = {
        version: firmwareVersion,
        hash: firmwareHash,
        signatureValid: true,
        verifiedAt: new Date().toISOString(),
      };
      this.verifiedFirmwares.set(firmwareVersion, verifiedInfo);

      this.logger.log(`固件签名验证通过: version=${firmwareVersion}, hash=${firmwareHash.substring(0, 16)}...`);

      return {
        valid: true,
        firmwareVersion,
        firmwareHash,
        signatureAlgorithm: this.SIGN_ALGORITHM,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error(`固件签名验证异常: ${error.message}`);
      return {
        valid: false,
        firmwareVersion,
        firmwareHash: '',
        signatureAlgorithm: this.SIGN_ALGORITHM,
        error: `验证异常: ${error.message}`,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 验证固件版本防降级
   *
   * @param currentVersion 当前固件版本
   * @param newVersion 新固件版本
   * @param allowDowngrade 是否允许降级（默认 false）
   * @returns 验证结果
   */
  verifyAntiRollback(currentVersion: string, newVersion: string, allowDowngrade: boolean = false): {
    allowed: boolean;
    reason?: string;
    currentVersion: string;
    newVersion: string;
  } {
    const comparison = this.compareVersions(newVersion, currentVersion);

    if (comparison < 0) {
      // 新版本低于当前版本（降级）
      if (allowDowngrade) {
        this.logger.warn(`固件降级已授权: ${currentVersion} -> ${newVersion}`);
        return { allowed: true, currentVersion, newVersion };
      }
      this.logger.warn(`固件降级被阻止: ${currentVersion} -> ${newVersion}`);
      return {
        allowed: false,
        reason: `固件版本降级被阻止（防回滚保护），当前版本 ${currentVersion} 高于新版本 ${newVersion}`,
        currentVersion,
        newVersion,
      };
    }

    if (comparison === 0) {
      return {
        allowed: false,
        reason: `新版本与当前版本相同（${currentVersion}），无需升级`,
        currentVersion,
        newVersion,
      };
    }

    return { allowed: true, currentVersion, newVersion };
  }

  /**
   * 验证固件完整性（哈希校验）
   */
  verifyIntegrity(firmwareData: Buffer, expectedHash: string): {
    valid: boolean;
    actualHash: string;
    expectedHash: string;
  } {
    const actualHash = crypto.createHash('sha256').update(firmwareData).digest('hex');
    const valid = actualHash.toLowerCase() === expectedHash.toLowerCase();

    if (!valid) {
      this.logger.error(`固件完整性校验失败: expected=${expectedHash.substring(0, 16)}..., actual=${actualHash.substring(0, 16)}...`);
    }

    return { valid, actualHash, expectedHash };
  }

  /**
   * 获取已验证的固件信息
   */
  getVerifiedFirmware(version: string): VerifiedFirmwareInfo | undefined {
    return this.verifiedFirmwares.get(version);
  }

  /**
   * 列出所有已验证的固件
   */
  listVerifiedFirmwares(): VerifiedFirmwareInfo[] {
    return Array.from(this.verifiedFirmwares.values());
  }

  /**
   * 开发模式签名验证
   */
  private devModeVerify(firmwareHash: string, signature: string): boolean {
    // 开发模式：验证签名是否为固件哈希的 Base64 编码
    try {
      const decoded = Buffer.from(signature, 'base64').toString('utf-8');
      return decoded === firmwareHash || decoded.includes(firmwareHash.substring(0, 32));
    } catch {
      return false;
    }
  }

  /**
   * 比较语义化版本号
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const parts2 = v2.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const maxLen = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLen; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }
}

/**
 * 固件验证结果
 */
export interface FirmwareVerificationResult {
  valid: boolean;
  firmwareVersion: string;
  firmwareHash: string;
  signatureAlgorithm: string;
  error?: string;
  verifiedAt: string;
  durationMs: number;
}

/**
 * 已验证固件信息
 */
interface VerifiedFirmwareInfo {
  version: string;
  hash: string;
  signatureValid: boolean;
  verifiedAt: string;
}
