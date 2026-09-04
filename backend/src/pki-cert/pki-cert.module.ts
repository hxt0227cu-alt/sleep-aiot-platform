import { Module } from '@nestjs/common';
import { CaManagerService } from './ca-manager.service';
import { CertSignService } from './cert-sign.service';
import { CrlService } from './crl-service.service';
import { CertLifecycleService } from './cert-lifecycle.service';
import { KmsAdapterService } from './kms-adapter.service';
import { UnifiedAuditModule } from '../unified-audit/unified-audit.module';
import { VaultSecretModule } from '../vault-secret/vault-secret.module';

/**
 * PKI 证书服务模块
 *
 * 维护离线根 CA + 在线中间 CA 分层结构：
 * - 根 CA 无在线调用接口，仅用于离线签发中间 CA
 * - 中间 CA 提供日常设备证书签发服务
 * - 普通租户共用中间 CA，高合规租户可选独立 CA
 */
@Module({
  imports: [UnifiedAuditModule, VaultSecretModule],
  providers: [CaManagerService, CertSignService, CrlService, CertLifecycleService, KmsAdapterService],
  exports: [CaManagerService, CertSignService, CrlService, CertLifecycleService, KmsAdapterService],
})
export class PkiCertModule {}
