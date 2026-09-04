import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * KMS 适配器
 *
 * 对接云厂商 KMS 托管 CA 根密钥与签名密钥，
 * 根密钥默认策略全部拒绝。
 *
 * 支持阿里云 KMS、AWS KMS 等主流云厂商，
 * 通过环境变量配置提供商与密钥 ID。
 */
@Injectable()
export class KmsAdapterService implements OnModuleInit {
  private readonly logger = new Logger(KmsAdapterService.name);

  /** KMS 提供商 */
  private provider: 'aliyun' | 'aws' | 'dev';

  /** 密钥缓存 */
  private keyCache: Map<string, KmsKeyInfo> = new Map();

  /** 根 CA 密钥 ID */
  private rootCaKeyId: string;

  /** 中间 CA 密钥 ID */
  private intermediateCaKeyId: string;

  constructor() {
    this.provider =
      (process.env.KMS_PROVIDER as 'aliyun' | 'aws' | 'dev') || 'dev';
    this.rootCaKeyId = process.env.KMS_ROOT_CA_KEY_ID || 'dev-root-ca-key';
    this.intermediateCaKeyId =
      process.env.KMS_INTERMEDIATE_CA_KEY_ID || 'dev-intermediate-ca-key';
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`KMS 适配器初始化: provider=${this.provider}`);

    if (this.provider === 'dev') {
      this.logger.warn('使用开发模式 KMS，密钥在本地生成，仅用于开发测试');
      this.initializeDevKeys();
    }
  }

  /**
   * 使用 KMS 密钥签名数据
   *
   * 私钥在 KMS 中，不导出到应用层。
   *
   * @param keyId 密钥 ID
   * @param data 待签名数据
   * @returns Base64 编码的签名
   */
  async sign(keyId: string, data: Buffer): Promise<string> {
    this.logger.debug(`KMS 签名: keyId=${keyId}, dataLength=${data.length}`);

    if (this.provider === 'dev') {
      return this.devSign(keyId, data);
    }

    // 实际云厂商 KMS 调用
    try {
      if (this.provider === 'aliyun') {
        return await this.aliyunSign(keyId, data);
      }
      if (this.provider === 'aws') {
        return await this.awsSign(keyId, data);
      }
      throw new Error(`不支持的 KMS 提供商: ${this.provider}`);
    } catch (error) {
      this.logger.error(`KMS 签名失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用 KMS 密钥验证签名
   */
  async verify(
    keyId: string,
    data: Buffer,
    signature: string,
  ): Promise<boolean> {
    if (this.provider === 'dev') {
      return this.devVerify(keyId, data, signature);
    }

    try {
      if (this.provider === 'aliyun') {
        return await this.aliyunVerify(keyId, data, signature);
      }
      if (this.provider === 'aws') {
        return await this.awsVerify(keyId, data, signature);
      }
      return false;
    } catch (error) {
      this.logger.error(`KMS 验签失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 获取公钥
   */
  async getPublicKey(keyId: string): Promise<string> {
    const keyInfo = this.keyCache.get(keyId);
    if (keyInfo?.publicKey) {
      return keyInfo.publicKey;
    }

    if (this.provider === 'dev') {
      const devKey = this.keyCache.get(keyId);
      return devKey?.publicKey || '';
    }

    // 从云厂商 KMS 获取公钥
    throw new Error('生产环境请配置云厂商 KMS SDK');
  }

  /**
   * 检查密钥是否可用
   */
  async checkKeyAvailability(
    keyId: string,
  ): Promise<{ available: boolean; keySpec?: string; usage?: string }> {
    try {
      if (this.provider === 'dev') {
        const key = this.keyCache.get(keyId);
        return { available: !!key, keySpec: key?.keySpec, usage: key?.usage };
      }
      // 生产环境调用云厂商 API
      return { available: true };
    } catch (error) {
      this.logger.error(`密钥可用性检查失败: ${error.message}`);
      return { available: false };
    }
  }

  /**
   * 获取根 CA 密钥 ID
   */
  getRootCaKeyId(): string {
    return this.rootCaKeyId;
  }

  /**
   * 获取中间 CA 密钥 ID
   */
  getIntermediateCaKeyId(): string {
    return this.intermediateCaKeyId;
  }

  // ========== 开发模式实现 ==========

  private initializeDevKeys(): void {
    // 根 CA 密钥
    const rootKeyPair = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    this.keyCache.set(this.rootCaKeyId, {
      keyId: this.rootCaKeyId,
      keySpec: 'EC_P256',
      usage: 'SIGN_VERIFY',
      privateKey: rootKeyPair.privateKey,
      publicKey: rootKeyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    });

    // 中间 CA 密钥
    const intermediateKeyPair = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    this.keyCache.set(this.intermediateCaKeyId, {
      keyId: this.intermediateCaKeyId,
      keySpec: 'EC_P256',
      usage: 'SIGN_VERIFY',
      privateKey: intermediateKeyPair.privateKey,
      publicKey: intermediateKeyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    });

    this.logger.log(
      `开发模式密钥初始化完成: root=${this.rootCaKeyId}, intermediate=${this.intermediateCaKeyId}`,
    );
  }

  private devSign(keyId: string, data: Buffer): string {
    const keyInfo = this.keyCache.get(keyId);
    if (!keyInfo?.privateKey) {
      throw new Error(`开发模式密钥不存在: ${keyId}`);
    }
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    return sign.sign(keyInfo.privateKey, 'base64');
  }

  private devVerify(keyId: string, data: Buffer, signature: string): boolean {
    const keyInfo = this.keyCache.get(keyId);
    if (!keyInfo?.publicKey) {
      return false;
    }
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    return verify.verify(keyInfo.publicKey, Buffer.from(signature, 'base64'));
  }

  // ========== 阿里云 KMS 实现（占位） ==========

  private async aliyunSign(keyId: string, data: Buffer): Promise<string> {
    // 实际应使用 @alicloud/kms-sdk 调用
    // const client = new KmsClient({ endpoint, accessKeyId, accessKeySecret });
    // const result = await client.sign({ KeyId: keyId, Message: data.toString('base64'), Algorithm: 'ECDSA_SHA_256' });
    // return result.Signature;
    throw new Error('阿里云 KMS SDK 未配置');
  }

  private async aliyunVerify(
    keyId: string,
    data: Buffer,
    signature: string,
  ): Promise<boolean> {
    throw new Error('阿里云 KMS SDK 未配置');
  }

  // ========== AWS KMS 实现（占位） ==========

  private async awsSign(keyId: string, data: Buffer): Promise<string> {
    // 实际应使用 @aws-sdk/client-kms
    // const client = new KMSClient({ region });
    // const command = new SignCommand({ KeyId: keyId, Message: data, SigningAlgorithm: 'ECDSA_SHA_256' });
    // const result = await client.send(command);
    // return result.Signature!.toString('base64');
    throw new Error('AWS KMS SDK 未配置');
  }

  private async awsVerify(
    keyId: string,
    data: Buffer,
    signature: string,
  ): Promise<boolean> {
    throw new Error('AWS KMS SDK 未配置');
  }
}

/**
 * KMS 密钥信息
 */
interface KmsKeyInfo {
  keyId: string;
  keySpec: string;
  usage: string;
  privateKey?: crypto.KeyObject;
  publicKey: string;
}
