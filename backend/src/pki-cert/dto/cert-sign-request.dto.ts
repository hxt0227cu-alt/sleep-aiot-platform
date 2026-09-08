import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

/**
 * 证书签发请求 DTO
 *
 * 仅含 CSR 与设备身份信息，服务端不生成、不存储设备私钥。
 */
export class CertSignRequestDto {
  /** 设备端生成的 PEM 格式 CSR */
  @IsString()
  @IsNotEmpty()
  csr!: string;

  /** 设备唯一标识 */
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  /** 硬件序列号 */
  @IsString()
  @IsOptional()
  serialNumber?: string;

  /** 设备型号 */
  @IsString()
  @IsOptional()
  deviceModel?: string;

  /** 固件版本 */
  @IsString()
  @IsOptional()
  firmwareVersion?: string;

  /** 租户 ID（高合规租户可选独立中间 CA） */
  @IsString()
  @IsOptional()
  tenantId?: string;

  /** 产线批次号 */
  @IsString()
  @IsOptional()
  productionBatch?: string;

  /** 附加证书扩展字段 */
  @IsOptional()
  @IsObject()
  extensions?: Record<string, string>;
}
