import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateLightAlarmDto } from './dto/create-light-alarm.dto';
import { UpdateLightAlarmDto } from './dto/update-light-alarm.dto';
import { UpdateLightAlarmEnabledDto } from './dto/update-light-alarm-enabled.dto';
import { LightAlarmService } from './light-alarm.service';

@ApiTags('设备光闹钟')
@ApiBearerAuth()
@Controller('devices/:deviceId/light-alarms')
@UseGuards(JwtAuthGuard)
export class LightAlarmController {
  constructor(private readonly lightAlarmService: LightAlarmService) {}

  @Get()
  @ApiOperation({ summary: '获取设备光闹钟列表' })
  @ApiParam({ name: 'deviceId', description: '设备 ID' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async list(@Param('deviceId') deviceId: string, @CurrentUser() user: any) {
    return await this.lightAlarmService.listByDevice(deviceId, user.id);
  }

  @Post()
  @ApiOperation({ summary: '创建光闹钟' })
  @ApiParam({ name: 'deviceId', description: '设备 ID' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: CreateLightAlarmDto,
  ) {
    return await this.lightAlarmService.create(deviceId, user.id, dto);
  }

  @Put(':alarmId')
  @ApiOperation({ summary: '更新光闹钟' })
  @ApiParam({ name: 'deviceId', description: '设备 ID' })
  @ApiParam({ name: 'alarmId', description: '光闹钟 ID' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async update(
    @Param('deviceId') deviceId: string,
    @Param('alarmId') alarmId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) dto: UpdateLightAlarmDto,
  ) {
    return await this.lightAlarmService.update(deviceId, alarmId, user.id, dto);
  }

  @Put(':alarmId/enabled')
  @ApiOperation({ summary: '启用或停用光闹钟' })
  @ApiParam({ name: 'deviceId', description: '设备 ID' })
  @ApiParam({ name: 'alarmId', description: '光闹钟 ID' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateEnabled(
    @Param('deviceId') deviceId: string,
    @Param('alarmId') alarmId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true }))
    dto: UpdateLightAlarmEnabledDto,
  ) {
    return await this.lightAlarmService.updateEnabled(
      deviceId,
      alarmId,
      user.id,
      dto.enabled,
    );
  }

  @Delete(':alarmId')
  @ApiOperation({ summary: '删除光闹钟' })
  @ApiParam({ name: 'deviceId', description: '设备 ID' })
  @ApiParam({ name: 'alarmId', description: '光闹钟 ID' })
  @ApiResponse({ status: 200, description: '删除成功' })
  async remove(
    @Param('deviceId') deviceId: string,
    @Param('alarmId') alarmId: string,
    @CurrentUser() user: any,
  ) {
    return await this.lightAlarmService.remove(deviceId, alarmId, user.id);
  }
}
