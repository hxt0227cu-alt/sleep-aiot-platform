import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * 参数包构建服务
 *
 * 生成标准化算法参数包，包含参数版本、兼容固件范围、算法类型、
 * Schema 版本、数字签名、生效时间、过期时间、回滚版本、设备分组等元数据。
 */
@Injectable()
export class ParamPackageBuilderService {
  private readonly logger = new Logger(ParamPackageBuilderService.name);

  /** 参数包 Schema 版本 */
  private readonly SCHEMA_VERSION = '1.0.0';

  /** 签名算法 */
  private readonly SIGN_ALGORITHM = 'ECDSA-SHA256';

  /**
   * 构建算法参数包
   *
   * @param config 参数包配置
   * @returns 构建完成的参数包
   */
  build(config: ParamPackageConfig): AlgorithmParamPackage {
    const packageId = `param-${config.algorithmType}-${config.paramVersion}-${Date.now()}`;

    const paramPackage: AlgorithmParamPackage = {
      packageId,
      schemaVersion: this.SCHEMA_VERSION,
      algorithmType: config.algorithmType,
      paramVersion: config.paramVersion,
      firmwareCompatibility: {
        minVersion: config.minFirmwareVersion,
        maxVersion: config.maxFirmwareVersion,
        supportedModels: config.supportedModels || [],
      },
      parameters: config.parameters,
      metadata: {
        name: config.name || `${config.algorithmType} 参数包 ${config.paramVersion}`,
        description: config.description || '',
        author: config.author || 'system',
        createdAt: new Date().toISOString(),
        effectiveFrom: config.effectiveFrom || new Date().toISOString(),
        expiresAt: config.expiresAt,
        rollbackVersion: config.rollbackVersion,
        deviceGroup: config.deviceGroup || 'all',
        priority: config.priority || 'normal',
        changelog: config.changelog || [],
      },
      signature: {
        algorithm: this.SIGN_ALGORITHM,
        signedAt: new Date().toISOString(),
        signer: config.signer || 'system',
        signatureValue: '', // 签名在下方计算
      },
    };

    // 计算签名
    paramPackage.signature.signatureValue = this.calculateSignature(paramPackage);

    this.logger.log(`参数包构建完成: ${packageId}, algorithm=${config.algorithmType}, version=${config.paramVersion}`);
    return paramPackage;
  }

  /**
   * 验证参数包签名
   */
  verifySignature(paramPackage: AlgorithmParamPackage, publicKey?: string): boolean {
    try {
      const signatureToVerify = paramPackage.signature.signatureValue;
      const packageWithoutSignature = {
        ...paramPackage,
        signature: { ...paramPackage.signature, signatureValue: '' },
      };
      const expectedSignature = this.calculateSignature(packageWithoutSignature);

      // 开发模式：简单比较
      if (!publicKey) {
        return signatureToVerify === expectedSignature;
      }

      // 生产模式：使用公钥验签
      const verify = crypto.createVerify('SHA256');
      verify.update(JSON.stringify(packageWithoutSignature));
      verify.end();
      return verify.verify(publicKey, Buffer.from(signatureToVerify, 'base64'));
    } catch (error) {
      this.logger.error(`参数包签名验证失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 验证固件兼容性
   */
  checkFirmwareCompatibility(paramPackage: AlgorithmParamPackage, firmwareVersion: string, deviceModel?: string): {
    compatible: boolean;
    reason?: string;
  } {
    const { minVersion, maxVersion, supportedModels } = paramPackage.firmwareCompatibility;

    // 版本比较
    if (this.compareVersions(firmwareVersion, minVersion) < 0) {
      return { compatible: false, reason: `固件版本 ${firmwareVersion} 低于最低要求 ${minVersion}` };
    }

    if (maxVersion && this.compareVersions(firmwareVersion, maxVersion) > 0) {
      return { compatible: false, reason: `固件版本 ${firmwareVersion} 高于最高支持 ${maxVersion}` };
    }

    // 设备型号检查
    if (supportedModels.length > 0 && deviceModel && !supportedModels.includes(deviceModel)) {
      return { compatible: false, reason: `设备型号 ${deviceModel} 不在支持列表中` };
    }

    return { compatible: true };
  }

  /**
   * 验证参数包完整性
   */
  validatePackage(paramPackage: AlgorithmParamPackage): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!paramPackage.packageId) errors.push('缺少 packageId');
    if (!paramPackage.schemaVersion) errors.push('缺少 schemaVersion');
    if (!paramPackage.algorithmType) errors.push('缺少 algorithmType');
    if (!paramPackage.paramVersion) errors.push('缺少 paramVersion');
    if (!paramPackage.firmwareCompatibility?.minVersion) errors.push('缺少最低固件版本要求');
    if (!paramPackage.parameters || Object.keys(paramPackage.parameters).length === 0) errors.push('参数内容为空');
    if (!paramPackage.signature?.signatureValue) errors.push('缺少数字签名');

    // 签名验证
    if (paramPackage.signature?.signatureValue && !this.verifySignature(paramPackage)) {
      errors.push('数字签名验证失败');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 生成参数包差异对比
   */
  generateDiff(oldPackage: AlgorithmParamPackage, newPackage: AlgorithmParamPackage): ParamPackageDiff {
    const changedParams: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
    const addedParams: string[] = [];
    const removedParams: string[] = [];

    const oldKeys = new Set(Object.keys(oldPackage.parameters));
    const newKeys = new Set(Object.keys(newPackage.parameters));

    for (const key of newKeys) {
      if (!oldKeys.has(key)) {
        addedParams.push(key);
      } else if (JSON.stringify(oldPackage.parameters[key]) !== JSON.stringify(newPackage.parameters[key])) {
        changedParams.push({ key, oldValue: oldPackage.parameters[key], newValue: newPackage.parameters[key] });
      }
    }

    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        removedParams.push(key);
      }
    }

    return {
      oldVersion: oldPackage.paramVersion,
      newVersion: newPackage.paramVersion,
      changedParams,
      addedParams,
      removedParams,
      firmwareCompatibilityChanged: JSON.stringify(oldPackage.firmwareCompatibility) !== JSON.stringify(newPackage.firmwareCompatibility),
    };
  }

  /**
   * 计算签名
   */
  private calculateSignature(paramPackage: AlgorithmParamPackage): string {
    // 开发模式：使用内容哈希作为签名
    const content = JSON.stringify({
      ...paramPackage,
      signature: { ...paramPackage.signature, signatureValue: '' },
    });
    return crypto.createHash('sha256').update(content).digest('base64');
  }

  /**
   * 比较语义化版本号
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map((n) => parseInt(n, 10) || 0);
    const parts2 = v2.split('.').map((n) => parseInt(n, 10) || 0);
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
 * 参数包配置
 */
export interface ParamPackageConfig {
  algorithmType: string;
  paramVersion: string;
  minFirmwareVersion: string;
  maxFirmwareVersion?: string;
  supportedModels?: string[];
  parameters: Record<string, unknown>;
  name?: string;
  description?: string;
  author?: string;
  effectiveFrom?: string;
  expiresAt?: string;
  rollbackVersion?: string;
  deviceGroup?: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  changelog?: string[];
  signer?: string;
}

/**
 * 算法参数包
 */
export interface AlgorithmParamPackage {
  packageId: string;
  schemaVersion: string;
  algorithmType: string;
  paramVersion: string;
  firmwareCompatibility: {
    minVersion: string;
    maxVersion?: string;
    supportedModels: string[];
  };
  parameters: Record<string, unknown>;
  metadata: {
    name: string;
    description: string;
    author: string;
    createdAt: string;
    effectiveFrom: string;
    expiresAt?: string;
    rollbackVersion?: string;
    deviceGroup: string;
    priority: string;
    changelog: string[];
  };
  signature: {
    algorithm: string;
    signedAt: string;
    signer: string;
    signatureValue: string;
  };
}

/**
 * 参数包差异
 */
export interface ParamPackageDiff {
  oldVersion: string;
  newVersion: string;
  changedParams: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
  addedParams: string[];
  removedParams: string[];
  firmwareCompatibilityChanged: boolean;
}
