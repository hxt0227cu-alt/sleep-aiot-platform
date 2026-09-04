import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AssistantService } from './assistant.service';
import { DeviceControlDto } from './dto/device-control.dto';
import { ExplainSleepReportDto } from './dto/explain-sleep-report.dto';
import { KnowledgeAskDto } from './dto/knowledge-ask.dto';

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('assistant')
@UseGuards(JwtAuthGuard)
export class AssistantController {
  constructor(private readonly assistantService: AssistantService) {}

  @Post('sleep-report/explain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explain a structured sleep report with LLM' })
  @ApiResponse({
    status: 200,
    description: 'Sleep report explanation generated successfully',
  })
  explainSleepReport(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: ExplainSleepReportDto,
  ) {
    return this.assistantService.explainSleepReport(user.id, dto);
  }

  @Post('device-control')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parse natural language into device control actions',
  })
  @ApiResponse({
    status: 200,
    description: 'Device control executed successfully',
  })
  controlDevice(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: DeviceControlDto,
  ) {
    return this.assistantService.controlDevice(user.id, dto);
  }

  @Post('knowledge/ask')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer knowledge questions with retrieval-augmented generation',
  })
  @ApiResponse({
    status: 200,
    description: 'Knowledge answer generated successfully',
  })
  askKnowledge(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: KnowledgeAskDto,
  ) {
    return this.assistantService.askKnowledge(user.id, dto);
  }
}
