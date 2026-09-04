import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DeviceService } from './device.service';
import { BindDeviceDto } from './dto/bind-device.dto';
import { DeviceCommandDto } from './dto/device-command.dto';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { CompleteProvisioningDto } from './dto/complete-provisioning.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('设备管理')
@ApiBearerAuth()
@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DeviceController {
  private readonly logger = new Logger(DeviceController.name);

  constructor(private readonly deviceService: DeviceService) {}

  @Post('provisioning-token')
  @ApiOperation({
    summary: '生成 BLE 配网绑定 token',
    description:
      '小程序添加设备前生成一次性 token，下发给设备并用于首次上线绑定',
  })
  @HttpCode(HttpStatus.OK)
  async createProvisioningToken(@CurrentUser() user: any) {
    return await this.deviceService.createProvisioningToken(user.id);
  }

  @Post('provisioning-complete')
  @ApiOperation({
    summary: '完成 BLE 配网绑定',
    description: '设备携带 token 上线后，小程序调用该接口完成用户-设备绑定',
  })
  @HttpCode(HttpStatus.OK)
  async completeProvisioning(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true }))
    body: CompleteProvisioningDto,
  ) {
    return await this.deviceService.completeProvisioning(user.id, body);
  }

  /**
   * 绑定设备 - 用户通过绑定码绑定设备
   */
  @Post('bind')
  @ApiOperation({ summary: '绑定设备', description: '用户通过绑定码绑定设备' })
  @ApiResponse({ status: 200, description: '设备绑定成功' })
  @ApiResponse({ status: 403, description: '绑定码无效或已过期' })
  @ApiResponse({ status: 404, description: '设备不存在' })
  @HttpCode(HttpStatus.OK)
  async bind(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) bindDeviceDto: BindDeviceDto,
  ) {
    try {
      this.logger.log(
        `User ${user.id} binding device ${bindDeviceDto.deviceId}`,
      );
      return await this.deviceService.bind(user.id, bindDeviceDto);
    } catch (error) {
      this.logger.error(`Device binding failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 解绑设备 - 用户解绑设备
   */
  @Delete(':deviceId/unbind')
  @ApiOperation({ summary: '解绑设备', description: '用户解绑设备' })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '设备解绑成功' })
  @ApiResponse({ status: 404, description: '设备未绑定' })
  async unbind(@CurrentUser() user: any, @Param('deviceId') deviceId: string) {
    try {
      this.logger.log(`User ${user.id} unbinding device ${deviceId}`);
      return await this.deviceService.unbind(user.id, deviceId);
    } catch (error) {
      this.logger.error(
        `Device unbinding failed: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取用户的所有设备列表
   */
  @Get()
  @ApiOperation({
    summary: '获取设备列表',
    description: '获取当前用户的所有设备列表',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching devices for user ${user.id}`);
      return await this.deviceService.findAllByUserId(user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch devices: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取设备详细信息
   */
  @Get(':deviceId')
  @ApiOperation({
    summary: '获取设备详情',
    description: '获取指定设备的详细信息',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async findOne(@Param('deviceId') deviceId: string, @CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching device ${deviceId} for user ${user.id}`);
      return await this.deviceService.findOne(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch device ${deviceId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 发送指令到设备
   */
  @Post(':deviceId/command')
  @ApiOperation({
    summary: '发送设备指令',
    description: '向指定设备发送控制指令',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '指令发送成功' })
  @ApiResponse({ status: 403, description: '设备离线，无法发送指令' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async sendCommand(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) commandDto: DeviceCommandDto,
  ) {
    try {
      this.logger.log(
        `User ${user.id} sending command ${commandDto.command} to device ${deviceId}`,
      );
      return await this.deviceService.sendCommand(
        deviceId,
        user.id,
        commandDto,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send command to device ${deviceId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 创建设备（管理员功能）
   */
  @Post('create')
  @ApiOperation({ summary: '创建设备', description: '管理员创建新设备' })
  @ApiResponse({ status: 201, description: '设备创建成功' })
  @ApiResponse({ status: 400, description: '该MAC地址的设备已存在' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ValidationPipe({ transform: true }))
    createDeviceDto: CreateDeviceDto,
  ) {
    try {
      this.logger.log(`Creating device: ${createDeviceDto.name}`);
      return await this.deviceService.create(createDeviceDto);
    } catch (error) {
      this.logger.error(
        `Failed to create device: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 更新设备信息
   */
  @Put(':deviceId')
  @ApiOperation({ summary: '更新设备信息', description: '更新指定设备的信息' })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '设备信息更新成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async update(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true }))
    updateDeviceDto: UpdateDeviceDto,
  ) {
    try {
      this.logger.log(`User ${user.id} updating device ${deviceId}`);
      return await this.deviceService.update(
        deviceId,
        user.id,
        updateDeviceDto,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update device ${deviceId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 删除设备（管理员功能）
   */
  @Delete(':deviceId')
  @ApiOperation({ summary: '删除设备', description: '管理员删除指定设备' })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '设备删除成功' })
  @ApiResponse({ status: 404, description: '设备不存在' })
  async remove(@Param('deviceId') deviceId: string) {
    try {
      this.logger.log(`Deleting device ${deviceId}`);
      return await this.deviceService.remove(deviceId);
    } catch (error) {
      this.logger.error(
        `Failed to delete device ${deviceId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取设备在线状态
   */
  @Get(':deviceId/status')
  @ApiOperation({
    summary: '获取设备在线状态',
    description: '获取指定设备的在线状态',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getOnlineStatus(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.debug(`Checking online status for device ${deviceId}`);
      return await this.deviceService.getOnlineStatus(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to get device status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 批量获取设备在线状态
   */
  @Post('batch-status')
  @ApiOperation({
    summary: '批量获取设备状态',
    description: '批量获取多个设备的在线状态',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @HttpCode(HttpStatus.OK)
  async getBatchOnlineStatus(
    @CurrentUser() user: any,
    @Body() body: { deviceIds: string[] },
  ) {
    try {
      if (!body.deviceIds || !Array.isArray(body.deviceIds)) {
        throw new Error('deviceIds must be an array');
      }

      if (body.deviceIds.length === 0) {
        throw new Error('deviceIds cannot be empty');
      }

      if (body.deviceIds.length > 100) {
        throw new Error('Maximum 100 device IDs allowed per request');
      }

      this.logger.debug(
        `Checking batch online status for ${body.deviceIds.length} devices`,
      );
      return await this.deviceService.getBatchOnlineStatus(
        body.deviceIds,
        user.id,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get batch device status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 更新设备配置
   */
  @Put(':deviceId/config')
  @ApiOperation({ summary: '更新设备配置', description: '更新指定设备的配置' })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '设备配置更新成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async updateConfig(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Body() body: { config: Record<string, any> },
  ) {
    try {
      if (!body.config || typeof body.config !== 'object') {
        throw new Error('config must be an object');
      }

      this.logger.log(`User ${user.id} updating config for device ${deviceId}`);
      return await this.deviceService.updateConfig(
        deviceId,
        user.id,
        body.config,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update device config: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取设备配置
   */
  @Get(':deviceId/config')
  @ApiOperation({ summary: '获取设备配置', description: '获取指定设备的配置' })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getConfig(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.debug(`Fetching config for device ${deviceId}`);
      return await this.deviceService.getConfig(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to get device config: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 刷新绑定码（设备重新绑定）
   */
  @Post(':deviceId/refresh-binding-code')
  @ApiOperation({
    summary: '刷新绑定码',
    description: '为指定设备生成新的绑定码',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '绑定码刷新成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async refreshBindingCode(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      this.logger.log(
        `User ${user.id} refreshing binding code for device ${deviceId}`,
      );
      return await this.deviceService.refreshBindingCode(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to refresh binding code: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取设备统计信息
   */
  @Get('stats/summary')
  @ApiOperation({
    summary: '获取设备统计',
    description: '获取当前用户的设备统计信息',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getDeviceStats(@CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching device stats for user ${user.id}`);
      return await this.deviceService.getDeviceStats(user.id);
    } catch (error) {
      this.logger.error(
        `Failed to get device stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
