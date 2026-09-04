import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AlgorithmProposalService } from './algorithm-proposal.service';
import {
  CreateAlgorithmProposalDto,
  RejectAlgorithmProposalDto,
  RollbackAlgorithmProposalDto,
  TransitionAlgorithmProposalDto,
} from './dto/algorithm-proposal.dto';

@Controller('algorithm-proposals')
@UseGuards(JwtAuthGuard)
export class AlgorithmProposalController {
  constructor(private readonly proposals: AlgorithmProposalService) {}

  @Post('from-run')
  create(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Req() request: Request & { requestId?: string },
    @Body(new ValidationPipe({ transform: true }))
    body: CreateAlgorithmProposalDto,
  ) {
    return this.proposals.createFromRun(
      user.id,
      body.runId,
      user.tenantId,
      request.requestId,
    );
  }

  @Get()
  list(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Query('status') status?: string,
  ) {
    return this.proposals.list(user.id, user.tenantId, status);
  }

  @Get(':proposalId')
  get(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') proposalId: string,
  ) {
    return this.proposals.get(user.id, proposalId, user.tenantId);
  }

  @Post(':proposalId/submit')
  submit(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: TransitionAlgorithmProposalDto,
  ) {
    return this.proposals.submit(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }

  @Post(':proposalId/approve')
  approve(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: TransitionAlgorithmProposalDto,
  ) {
    return this.proposals.approve(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }

  @Post(':proposalId/reject')
  reject(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: RejectAlgorithmProposalDto,
  ) {
    return this.proposals.reject(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }

  @Post(':proposalId/start-canary')
  startCanary(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: TransitionAlgorithmProposalDto,
  ) {
    return this.proposals.startCanary(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }

  @Post(':proposalId/promote')
  promote(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: TransitionAlgorithmProposalDto,
  ) {
    return this.proposals.promote(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }

  @Post(':proposalId/rollback')
  rollback(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('proposalId') id: string,
    @Body() body: RollbackAlgorithmProposalDto,
  ) {
    return this.proposals.rollback(
      user.id,
      id,
      body.version,
      user.tenantId,
      body.reason,
    );
  }
}
