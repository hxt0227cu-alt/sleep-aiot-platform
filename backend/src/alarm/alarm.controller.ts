import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AlarmService } from './alarm.service';
import { AlarmConfigDto } from './dto/alarm-config.dto';
import { AlarmQueryDto } from './dto/alarm-query.dto';
import { HandleAlarmDto } from './dto/handle-alarm.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('报警管理')
@ApiBearerAuth()
@Controller('alarms')
@UseGuards(JwtAuthGuard)
export class AlarmController {
  private readonly logger = new Logger(AlarmController.name);

  constructor(private readonly alarmService: AlarmService) {}

  /**
   * 获取报警列表
   */
  @Get()
  @ApiOperation({
    summary: '获取报警列表',
    description: '获取当前用户的报警记录列表',
  })
  @ApiQuery({ name: 'deviceId', description: '设备ID', required: false })
  @ApiQuery({
    name: 'startTime',
    description: '开始时间（ISO 8601格式）',
    required: false,
  })
  @ApiQuery({
    name: 'endTime',
    description: '结束时间（ISO 8601格式）',
    required: false,
  })
  @ApiQuery({
    name: 'level',
    description: '报警级别',
    required: false,
    enum: ['info', 'warning', 'error', 'critical'],
  })
  @ApiQuery({ name: 'page', description: '页码', required: false, example: 1 })
  @ApiQuery({
    name: 'pageSize',
    description: '每页数量',
    required: false,
    example: 20,
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  async findAll(
    @CurrentUser() user: any,
    @Query(new ValidationPipe({ transform: true })) queryDto: AlarmQueryDto,
  ) {
    try {
      // 验证分页参数
      if (queryDto.page && queryDto.page < 1) {
        throw new Error('Page must be greater than 0');
      }

      if (
        queryDto.pageSize &&
        (queryDto.pageSize < 1 || queryDto.pageSize > 100)
      ) {
        throw new Error('PageSize must be between 1 and 100');
      }

      // 验证时间范围
      if (queryDto.startTime && queryDto.endTime) {
        const startDate = new Date(queryDto.startTime);
        const endDate = new Date(queryDto.endTime);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          throw new Error('Invalid date format');
        }

        if (startDate >= endDate) {
          throw new Error('startTime must be before endTime');
        }
      }

      this.logger.debug(`Fetching alarms for user ${user.id}`);
      return await this.alarmService.getAlarms(user.id, queryDto);
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarms: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取报警详情
   */
  @Get(':alarmId')
  @ApiOperation({
    summary: '获取报警详情',
    description: '获取指定报警的详细信息',
  })
  @ApiParam({ name: 'alarmId', description: '报警ID', example: 'alarm_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '报警不存在或无权限访问' })
  async findOne(@Param('alarmId') alarmId: string, @CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching alarm ${alarmId} for user ${user.id}`);
      return await this.alarmService.getAlarmById(alarmId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarm ${alarmId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 配置报警规则
   */
  @Post('config')
  @ApiOperation({
    summary: '配置报警规则',
    description: '为指定设备配置报警规则',
  })
  @ApiResponse({ status: 200, description: '报警配置成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async configure(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) configDto: AlarmConfigDto,
  ) {
    try {
      // 验证设备ID
      if (!configDto.deviceId) {
        throw new Error('deviceId is required');
      }

      // 验证规则
      if (!configDto.rules || !Array.isArray(configDto.rules)) {
        throw new Error('rules must be an array');
      }

      if (configDto.rules.length === 0) {
        throw new Error('rules cannot be empty');
      }

      if (configDto.rules.length > 10) {
        throw new Error('Maximum 10 rules allowed per device');
      }

      // 验证每个规则
      const validTypes = [
        'heart_rate_high',
        'heart_rate_low',
        'breathing_rate_high',
        'breathing_rate_low',
        'apnea',
        'movement_abnormal',
      ];
      const validLevels = ['info', 'warning', 'error', 'critical'];
      const validActions = ['push', 'sms', 'email', 'call'];

      for (const rule of configDto.rules) {
        if (!rule.type || !validTypes.includes(rule.type)) {
          throw new Error(`Invalid rule type: ${rule.type}`);
        }

        if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
          throw new Error('enabled must be a boolean');
        }

        if (
          rule.threshold !== undefined &&
          (typeof rule.threshold !== 'number' || rule.threshold < 0)
        ) {
          throw new Error('threshold must be a positive number');
        }

        if (
          rule.duration !== undefined &&
          (typeof rule.duration !== 'number' ||
            rule.duration < 0 ||
            rule.duration > 3600)
        ) {
          throw new Error('duration must be between 0 and 3600 seconds');
        }

        if (rule.actions && Array.isArray(rule.actions)) {
          const invalidActions = rule.actions.filter(
            (a) => !validActions.includes(a),
          );
          if (invalidActions.length > 0) {
            throw new Error(`Invalid actions: ${invalidActions.join(', ')}`);
          }
        }
      }

      this.logger.log(
        `User ${user.id} configuring alarm rules for device ${configDto.deviceId}`,
      );
      return await this.alarmService.configureAlarm(user.id, configDto);
    } catch (error) {
      this.logger.error(
        `Failed to configure alarm rules: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取报警配置
   */
  @Get('config/:deviceId')
  @ApiOperation({
    summary: '获取报警配置',
    description: '获取指定设备的报警规则配置',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getDeviceConfig(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.debug(`Fetching alarm config for device ${deviceId}`);
      return await this.alarmService.getAlarmConfig(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarm config: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 处理报警
   */
  @Put(':alarmId/handle')
  @ApiOperation({ summary: '处理报警', description: '标记指定报警为已处理' })
  @ApiParam({ name: 'alarmId', description: '报警ID', example: 'alarm_001' })
  @ApiResponse({ status: 200, description: '报警已标记为已处理' })
  @ApiResponse({ status: 404, description: '报警不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('alarmId') alarmId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) handleDto: HandleAlarmDto,
  ) {
    try {
      // 验证备注长度
      if (handleDto.note && handleDto.note.length > 500) {
        throw new Error('Note cannot exceed 500 characters');
      }

      this.logger.log(`User ${user.id} handling alarm ${alarmId}`);
      return await this.alarmService.handleAlarm(alarmId, user.id, handleDto);
    } catch (error) {
      this.logger.error(
        `Failed to handle alarm ${alarmId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 批量处理报警
   */
  @Post('batch-handle')
  @ApiOperation({
    summary: '批量处理报警',
    description: '批量标记报警为已处理',
  })
  @ApiResponse({ status: 200, description: '批量处理成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async batchHandle(
    @CurrentUser() user: any,
    @Body() body: { alarmIds: string[]; status?: string; note?: string },
  ) {
    try {
      // 验证报警ID列表
      if (!body.alarmIds || !Array.isArray(body.alarmIds)) {
        throw new Error('alarmIds must be an array');
      }

      if (body.alarmIds.length === 0) {
        throw new Error('alarmIds cannot be empty');
      }

      if (body.alarmIds.length > 50) {
        throw new Error('Maximum 50 alarm IDs allowed per request');
      }

      // 验证状态
      if (body.status) {
        const validStatuses = ['handled', 'ignored', 'resolved'];
        if (!validStatuses.includes(body.status)) {
          throw new Error(`Invalid status: ${body.status}`);
        }
      }

      // 验证备注长度
      if (body.note && body.note.length > 500) {
        throw new Error('Note cannot exceed 500 characters');
      }

      this.logger.log(
        `User ${user.id} batch handling ${body.alarmIds.length} alarms`,
      );
      return await this.alarmService.batchHandleAlarms(
        body.alarmIds,
        user.id,
        body.status || 'handled',
        body.note,
      );
    } catch (error) {
      this.logger.error(
        `Failed to batch handle alarms: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取待处理报警
   */
  @Get('pending')
  @ApiOperation({
    summary: '获取待处理报警',
    description: '获取当前用户的待处理报警列表',
  })
  @ApiQuery({ name: 'deviceId', description: '设备ID', required: false })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getPendingAlarms(
    @CurrentUser() user: any,
    @Query('deviceId') deviceId?: string,
  ) {
    try {
      this.logger.debug(`Fetching pending alarms for user ${user.id}`);
      return await this.alarmService.getPendingAlarms(user.id, deviceId);
    } catch (error) {
      this.logger.error(
        `Failed to fetch pending alarms: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取报警统计信息
   */
  @Get('statistics')
  @ApiOperation({ summary: '获取报警统计', description: '获取报警统计信息' })
  @ApiQuery({ name: 'deviceId', description: '设备ID', required: false })
  @ApiQuery({
    name: 'startTime',
    description: '开始时间（ISO 8601格式）',
    required: false,
  })
  @ApiQuery({
    name: 'endTime',
    description: '结束时间（ISO 8601格式）',
    required: false,
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getStatistics(
    @CurrentUser() user: any,
    @Query('deviceId') deviceId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    try {
      // 验证时间范围
      let startDate: Date | undefined;
      let endDate: Date | undefined;

      if (startTime) {
        startDate = new Date(startTime);
        if (isNaN(startDate.getTime())) {
          throw new Error('Invalid startTime format');
        }
      }

      if (endTime) {
        endDate = new Date(endTime);
        if (isNaN(endDate.getTime())) {
          throw new Error('Invalid endTime format');
        }
      }

      if (startDate && endDate && startDate >= endDate) {
        throw new Error('startTime must be before endTime');
      }

      this.logger.debug(`Fetching alarm statistics for user ${user.id}`);
      return await this.alarmService.getAlarmStatistics(
        user.id,
        deviceId,
        startDate,
        endDate,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarm statistics: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取报警趋势
   */
  @Get('trends')
  @ApiOperation({ summary: '获取报警趋势', description: '获取报警趋势数据' })
  @ApiQuery({ name: 'deviceId', description: '设备ID', required: false })
  @ApiQuery({ name: 'days', description: '天数', required: false, example: 7 })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getTrends(
    @CurrentUser() user: any,
    @Query('deviceId') deviceId?: string,
    @Query('days', new DefaultValuePipe(7), new ParseIntPipe())
    days: number = 7,
  ) {
    try {
      // 验证天数
      if (days < 1 || days > 365) {
        throw new Error('Days must be between 1 and 365');
      }

      this.logger.debug(
        `Fetching alarm trends for user ${user.id} over ${days} days`,
      );
      return await this.alarmService.getAlarmTrends(user.id, deviceId, days);
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarm trends: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取设备报警摘要
   */
  @Get('summary/:deviceId')
  @ApiOperation({
    summary: '获取设备报警摘要',
    description: '获取指定设备的报警摘要信息',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getDeviceSummary(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.debug(`Fetching alarm summary for device ${deviceId}`);
      return await this.alarmService.getDeviceAlarmSummary(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch device alarm summary: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 删除报警
   */
  @Delete(':alarmId')
  @ApiOperation({ summary: '删除报警', description: '删除指定的报警记录' })
  @ApiParam({ name: 'alarmId', description: '报警ID', example: 'alarm_001' })
  @ApiResponse({ status: 200, description: '报警删除成功' })
  @ApiResponse({ status: 404, description: '报警不存在或无权限访问' })
  async deleteAlarm(
    @Param('alarmId') alarmId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.log(`User ${user.id} deleting alarm ${alarmId}`);
      return await this.alarmService.deleteAlarm(alarmId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to delete alarm ${alarmId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取报警规则统计
   */
  @Get('rules/statistics/:deviceId')
  @ApiOperation({
    summary: '获取报警规则统计',
    description: '获取指定设备的报警规则统计信息',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getRuleStatistics(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.debug(
        `Fetching alarm rule statistics for device ${deviceId}`,
      );
      return await this.alarmService.getRuleStatistics(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch alarm rule statistics: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取通知历史
   */
  @Get(':alarmId/notifications')
  @ApiOperation({
    summary: '获取通知历史',
    description: '获取指定报警的通知历史',
  })
  @ApiParam({ name: 'alarmId', description: '报警ID', example: 'alarm_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getNotificationHistory(@Param('alarmId') alarmId: string) {
    try {
      this.logger.debug(`Fetching notification history for alarm ${alarmId}`);
      return this.alarmService.getNotificationHistory(alarmId);
    } catch (error) {
      this.logger.error(
        `Failed to fetch notification history: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取通知失败统计
   */
  @Get('notifications/failure-stats')
  @ApiOperation({
    summary: '获取通知失败统计',
    description: '获取通知发送失败统计信息',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getNotificationFailureStats() {
    try {
      this.logger.debug('Fetching notification failure stats');
      return this.alarmService.getNotificationFailureStats();
    } catch (error) {
      this.logger.error(
        `Failed to fetch notification failure stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 重置通知失败统计
   */
  @Post('notifications/reset-failure-stats')
  @ApiOperation({
    summary: '重置通知失败统计',
    description: '重置通知发送失败统计信息',
  })
  @ApiQuery({
    name: 'channelType',
    description: '通知渠道类型',
    required: false,
  })
  @ApiResponse({ status: 200, description: '重置成功' })
  @HttpCode(HttpStatus.OK)
  async resetNotificationFailureStats(
    @Query('channelType') channelType?: string,
  ) {
    try {
      this.logger.log(
        `Resetting notification failure stats for channel: ${channelType || 'all'}`,
      );
      return this.alarmService.resetNotificationFailureStats(channelType);
    } catch (error) {
      this.logger.error(
        `Failed to reset notification failure stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
