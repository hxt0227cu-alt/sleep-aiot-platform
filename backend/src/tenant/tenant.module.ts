import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TenantService } from './tenant.service';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
