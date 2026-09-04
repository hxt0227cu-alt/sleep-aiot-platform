import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';
import { CreateAgentMemoryDto } from './dto/agent-memory.dto';
import { AgentRunService } from './agent-run.service';

@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentRunController {
  constructor(private readonly runs: AgentRunService) {}

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Req() request: Request & { requestId?: string },
    @Body(new ValidationPipe({ transform: true })) dto: CreateAgentRunDto,
  ) {
    return this.runs.create(user.id, {
      ...dto,
      tenantId: dto.tenantId || user.tenantId,
      requestId: request.requestId,
    });
  }

  @Get('runs/:runId')
  get(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('runId') runId: string,
  ) {
    return this.runs.get(user.id, runId, user.tenantId);
  }

  @Post('runs/:runId/approve')
  approve(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('runId') runId: string,
  ) {
    return this.runs.approve(user.id, runId, user.tenantId);
  }

  @Post('runs/:runId/cancel')
  cancel(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('runId') runId: string,
  ) {
    return this.runs.cancel(user.id, runId, user.tenantId);
  }

  @Post('memories/preferences')
  createPreferenceMemory(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Body(new ValidationPipe({ transform: true })) dto: CreateAgentMemoryDto,
  ) {
    return this.runs.createPreferenceMemory(
      user.id,
      dto,
      dto.tenantId || user.tenantId,
    );
  }

  @Get('memories/preferences')
  listPreferenceMemories(
    @CurrentUser() user: { id: string; tenantId?: string },
  ) {
    return this.runs.listPreferenceMemories(user.id, user.tenantId);
  }

  @Delete('memories/preferences/:memoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePreferenceMemory(
    @CurrentUser() user: { id: string; tenantId?: string },
    @Param('memoryId') memoryId: string,
  ) {
    await this.runs.deletePreferenceMemory(user.id, memoryId, user.tenantId);
  }
}
