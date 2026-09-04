import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { TenantModule } from '../tenant/tenant.module';
import { AlgorithmProposalController } from './algorithm-proposal.controller';
import { AlgorithmProposalService } from './algorithm-proposal.service';

@Module({
  imports: [AuthModule, DatabaseModule, TenantModule],
  controllers: [AlgorithmProposalController],
  providers: [AlgorithmProposalService],
})
export class AlgorithmProposalModule {}
