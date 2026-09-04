import { Module } from '@nestjs/common';
import { VaultAdapterService } from './vault-adapter.service';
import { SecretRotatorService } from './secret-rotator.service';
import { AccessAuditService } from './access-audit.service';
import { UnifiedAuditModule } from '../unified-audit/unified-audit.module';

/**
 * Vault 密钥适配模块
 *
 * 对接 HashiCorp Vault 集群，作为应用运行时密钥的唯一读取入口。
 */
@Module({
  imports: [UnifiedAuditModule],
  providers: [VaultAdapterService, SecretRotatorService, AccessAuditService],
  exports: [VaultAdapterService, SecretRotatorService, AccessAuditService],
})
export class VaultSecretModule {}
