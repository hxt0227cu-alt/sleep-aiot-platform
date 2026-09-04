import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { TenantModule } from '../tenant/tenant.module';
import { AgentRunController } from './agent-run.controller';
import { AgentRunService } from './agent-run.service';

@Module({
  imports: [AuthModule, DatabaseModule, TenantModule],
  controllers: [AgentRunController],
  providers: [AgentRunService],
})
export class AgentRunModule {}
