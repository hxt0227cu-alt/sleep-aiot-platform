import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SleepService } from './sleep.service';
import { CreateSleepDiaryDto } from './dto/create-sleep-diary.dto';
import { CreateSleepRelaxRecordDto } from './dto/create-sleep-relax-record.dto';
import { CreateSleepRoutineRecordDto } from './dto/create-sleep-routine-record.dto';
import { SleepHistoryDto } from './dto/sleep-history.dto';
import { SleepPlanDto } from './dto/sleep-plan.dto';
import { SleepReportDto } from './dto/sleep-report.dto';
import { SleepRoutineTemplateDto } from './dto/sleep-routine-template.dto';
import { SleepTrendDto } from './dto/sleep-trend.dto';
import { UpdateSleepDiaryDto } from './dto/update-sleep-diary.dto';

@ApiTags('sleep')
@ApiBearerAuth()
@Controller('sleep')
@UseGuards(JwtAuthGuard)
export class SleepController {
  private readonly logger = new Logger(SleepController.name);

  constructor(private readonly sleepService: SleepService) {}

  @Get('plan')
  @ApiOperation({ summary: 'Get the current sleep plan' })
  @ApiResponse({ status: 200, description: 'Sleep plan loaded successfully' })
  getSleepPlan(@CurrentUser() user: any) {
    return this.sleepService.getSleepPlan(user.id);
  }

  @Put('plan')
  @ApiOperation({ summary: 'Create or update the current sleep plan' })
  @ApiResponse({ status: 200, description: 'Sleep plan updated successfully' })
  updateSleepPlan(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: SleepPlanDto,
  ) {
    return this.sleepService.updateSleepPlan(user.id, dto);
  }

  @Get('routine-template')
  @ApiOperation({ summary: 'Get the current bedtime routine template' })
  @ApiResponse({
    status: 200,
    description: 'Routine template loaded successfully',
  })
  getRoutineTemplate(@CurrentUser() user: any) {
    return this.sleepService.getRoutineTemplate(user.id);
  }

  @Put('routine-template')
  @ApiOperation({ summary: 'Create or update the bedtime routine template' })
  @ApiResponse({
    status: 200,
    description: 'Routine template updated successfully',
  })
  updateRoutineTemplate(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: SleepRoutineTemplateDto,
  ) {
    return this.sleepService.updateRoutineTemplate(user.id, dto);
  }

  @Post('routine-records')
  @ApiOperation({ summary: 'Create a bedtime routine execution record' })
  @ApiResponse({
    status: 201,
    description: 'Routine record created successfully',
  })
  createRoutineRecord(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true }))
    dto: CreateSleepRoutineRecordDto,
  ) {
    return this.sleepService.createRoutineRecord(user.id, dto);
  }

  @Get('routine-records')
  @ApiOperation({ summary: 'List bedtime routine execution records' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Routine records loaded successfully',
  })
  getRoutineRecords(
    @CurrentUser() user: any,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.sleepService.getRoutineRecords(user.id, limit);
  }

  @Get('diaries')
  @ApiOperation({ summary: 'List sleep diaries' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Sleep diaries loaded successfully',
  })
  getDiaries(
    @CurrentUser() user: any,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.sleepService.getDiaries(user.id, limit);
  }

  @Post('diaries')
  @ApiOperation({ summary: 'Create a sleep diary entry' })
  @ApiResponse({ status: 201, description: 'Sleep diary created successfully' })
  createDiary(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: CreateSleepDiaryDto,
  ) {
    return this.sleepService.createDiary(user.id, dto);
  }

  @Get('diaries/:diaryId')
  @ApiOperation({ summary: 'Get one sleep diary entry' })
  @ApiParam({ name: 'diaryId', description: 'Sleep diary ID' })
  @ApiResponse({ status: 200, description: 'Sleep diary loaded successfully' })
  getDiary(@CurrentUser() user: any, @Param('diaryId') diaryId: string) {
    return this.sleepService.getDiary(user.id, diaryId);
  }

  @Put('diaries/:diaryId')
  @ApiOperation({ summary: 'Update one sleep diary entry' })
  @ApiParam({ name: 'diaryId', description: 'Sleep diary ID' })
  @ApiResponse({ status: 200, description: 'Sleep diary updated successfully' })
  updateDiary(
    @CurrentUser() user: any,
    @Param('diaryId') diaryId: string,
    @Body(new ValidationPipe({ transform: true })) dto: UpdateSleepDiaryDto,
  ) {
    return this.sleepService.updateDiary(user.id, diaryId, dto);
  }

  @Post('relax-records')
  @ApiOperation({ summary: 'Create a relaxation training record' })
  @ApiResponse({
    status: 201,
    description: 'Relaxation record created successfully',
  })
  createRelaxRecord(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true }))
    dto: CreateSleepRelaxRecordDto,
  ) {
    return this.sleepService.createRelaxRecord(user.id, dto);
  }

  @Get('relax-records')
  @ApiOperation({ summary: 'List relaxation training records' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Relaxation records loaded successfully',
  })
  getRelaxRecords(
    @CurrentUser() user: any,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.sleepService.getRelaxRecords(user.id, limit);
  }

  @Get(':deviceId/realtime')
  @ApiOperation({ summary: 'Get realtime sleep monitoring data' })
  @ApiParam({ name: 'deviceId', description: 'Device ID' })
  @ApiResponse({
    status: 200,
    description: 'Realtime sleep data loaded successfully',
  })
  async getRealtimeData(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    this.logger.debug(`Fetching realtime sleep data for device ${deviceId}`);
    return this.sleepService.getRealtimeData(deviceId, user.id);
  }

  @Get(':deviceId/history')
  @ApiOperation({ summary: 'Get historical sleep monitoring data' })
  @ApiParam({ name: 'deviceId', description: 'Device ID' })
  @ApiResponse({
    status: 200,
    description: 'History sleep data loaded successfully',
  })
  async getHistoryData(
    @Param('deviceId') deviceId: string,
    @Query(new ValidationPipe({ transform: true })) historyDto: SleepHistoryDto,
    @CurrentUser() user: any,
  ) {
    this.logger.debug(
      `Fetching sleep history for device ${deviceId} from ${historyDto.startTime} to ${historyDto.endTime}`,
    );
    return this.sleepService.getHistoryData(deviceId, user.id, historyDto);
  }

  @Get(':deviceId/report')
  @ApiOperation({ summary: 'Get the daily sleep report for a device' })
  @ApiParam({ name: 'deviceId', description: 'Device ID' })
  @ApiResponse({ status: 200, description: 'Sleep report loaded successfully' })
  async getReport(
    @Param('deviceId') deviceId: string,
    @Query(new ValidationPipe({ transform: true })) reportDto: SleepReportDto,
    @CurrentUser() user: any,
  ) {
    this.logger.debug(`Fetching sleep report for device ${deviceId}`);
    return this.sleepService.getReport(deviceId, user.id, reportDto);
  }

  @Get(':deviceId/trend')
  @ApiOperation({ summary: 'Get sleep trend data for a device' })
  @ApiParam({ name: 'deviceId', description: 'Device ID' })
  @ApiResponse({ status: 200, description: 'Sleep trend loaded successfully' })
  async getTrend(
    @Param('deviceId') deviceId: string,
    @Query(new ValidationPipe({ transform: true })) trendDto: SleepTrendDto,
    @CurrentUser() user: any,
  ) {
    this.logger.debug(`Fetching sleep trend for device ${deviceId}`);
    return this.sleepService.getTrend(deviceId, user.id, trendDto);
  }
}
