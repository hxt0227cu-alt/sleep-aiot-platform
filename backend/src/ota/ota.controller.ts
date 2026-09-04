import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  Logger,
  Query,
  Delete,
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
import { OtaService } from './ota.service';
import { OtaProgressDto } from './dto/ota-progress.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('OTA升级')
@ApiBearerAuth()
@Controller('ota')
@UseGuards(JwtAuthGuard)
export class OtaController {
  private readonly logger = new Logger(OtaController.name);

  constructor(private readonly otaService: OtaService) {}

  /**
   * 检查固件更新
   */
  @Get('check/:deviceId')
  @ApiOperation({
    summary: '检查固件更新',
    description: '检查指定设备是否有可用的固件更新',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '检查成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async checkUpdate(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!deviceIdRegex.test(deviceId)) {
        throw new Error('Invalid device ID format');
      }

      this.logger.debug(`Checking OTA update for device ${deviceId}`);
      return await this.otaService.checkUpdate(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to check OTA update: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 开始OTA升级
   */
  @Post('start/:deviceId')
  @ApiOperation({
    summary: '开始OTA升级',
    description: '为指定设备开始OTA固件升级',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '升级开始成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async startUpdate(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Body() body: { version: string; force?: boolean },
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!deviceIdRegex.test(deviceId)) {
        throw new Error('Invalid device ID format');
      }

      // 验证版本号格式
      if (
        !body.version ||
        body.version.length < 5 ||
        body.version.length > 20
      ) {
        throw new Error('Invalid firmware version format');
      }

      const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
      if (!versionRegex.test(body.version)) {
        throw new Error(
          'Firmware version must be in format: X.Y.Z or X.Y.Z-rcN',
        );
      }

      this.logger.log(
        `Starting OTA update for device ${deviceId} to version ${body.version}`,
      );
      return await this.otaService.startUpdate(
        deviceId,
        user.id,
        body.version,
        body.force || false,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start OTA update: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 取消OTA升级
   */
  @Post('cancel/:deviceId')
  @ApiOperation({
    summary: '取消OTA升级',
    description: '取消指定设备的OTA升级',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '取消成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  @HttpCode(HttpStatus.OK)
  async cancelUpdate(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!deviceIdRegex.test(deviceId)) {
        throw new Error('Invalid device ID format');
      }

      this.logger.log(`Cancelling OTA update for device ${deviceId}`);
      return await this.otaService.cancelUpdate(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to cancel OTA update: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取OTA升级进度
   */
  @Get('progress/:deviceId')
  @ApiOperation({
    summary: '获取OTA升级进度',
    description: '获取指定设备的OTA升级进度',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getProgress(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!deviceIdRegex.test(deviceId)) {
        throw new Error('Invalid device ID format');
      }

      this.logger.debug(`Fetching OTA progress for device ${deviceId}`);
      return await this.otaService.getProgress(deviceId, user.id);
    } catch (error) {
      this.logger.error(
        `Failed to get OTA progress: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 报告OTA升级进度（设备端调用）
   */
  @Post('progress')
  @ApiOperation({
    summary: '报告OTA升级进度',
    description: '设备端报告OTA升级进度',
  })
  @ApiResponse({ status: 200, description: '报告成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async reportProgress(
    @Body(new ValidationPipe({ transform: true })) progressDto: OtaProgressDto,
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!progressDto.deviceId || !deviceIdRegex.test(progressDto.deviceId)) {
        throw new Error('Invalid device ID format');
      }

      // 验证进度值范围
      if (
        progressDto.progress !== undefined &&
        (progressDto.progress < 0 || progressDto.progress > 100)
      ) {
        throw new Error('Progress must be between 0 and 100');
      }

      // 验证状态
      const validStatuses = [
        'downloading',
        'installing',
        'completed',
        'failed',
        'cancelled',
      ];
      if (!progressDto.status || !validStatuses.includes(progressDto.status)) {
        throw new Error(
          `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        );
      }

      // 验证错误信息长度
      if (progressDto.error && progressDto.error.length > 500) {
        throw new Error('Error message cannot exceed 500 characters');
      }

      this.logger.debug(
        `OTA progress reported for device ${progressDto.deviceId}: ${progressDto.progress}%`,
      );
      return await this.otaService.reportProgress(progressDto);
    } catch (error) {
      this.logger.error(
        `Failed to report OTA progress: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取OTA升级历史
   */
  @Get('history/:deviceId')
  @ApiOperation({
    summary: '获取OTA升级历史',
    description: '获取指定设备的OTA升级历史记录',
  })
  @ApiParam({ name: 'deviceId', description: '设备ID', example: 'device_001' })
  @ApiQuery({ name: 'page', description: '页码', required: false, example: 1 })
  @ApiQuery({
    name: 'pageSize',
    description: '每页数量',
    required: false,
    example: 20,
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: '设备不存在或无权限访问' })
  async getHistory(
    @Param('deviceId') deviceId: string,
    @CurrentUser() user: any,
    @Query('page', new DefaultValuePipe(1)) page: number = 1,
    @Query('pageSize', new DefaultValuePipe(20)) pageSize: number = 20,
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!deviceIdRegex.test(deviceId)) {
        throw new Error('Invalid device ID format');
      }

      // 验证分页参数
      if (page < 1) {
        throw new Error('Page must be greater than 0');
      }

      if (pageSize < 1 || pageSize > 100) {
        throw new Error('PageSize must be between 1 and 100');
      }

      this.logger.debug(`Fetching OTA history for device ${deviceId}`);
      return await this.otaService.getHistory(
        deviceId,
        user.id,
        page,
        pageSize,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get OTA history: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取可用固件版本列表
   */
  @Get('versions')
  @ApiOperation({
    summary: '获取可用固件版本',
    description: '获取所有可用的固件版本列表',
  })
  @ApiQuery({ name: 'deviceType', description: '设备类型', required: false })
  @ApiQuery({
    name: 'latestOnly',
    description: '仅返回最新版本',
    required: false,
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getVersions(
    @Query('deviceType') deviceType?: string,
    @Query('latestOnly') latestOnly?: string,
  ) {
    try {
      // 验证设备类型
      if (deviceType) {
        const validTypes = ['sleep_lamp', 'sleep_monitor', 'smart_bed'];
        if (!validTypes.includes(deviceType)) {
          throw new Error(
            `Invalid device type. Must be one of: ${validTypes.join(', ')}`,
          );
        }
      }

      const onlyLatest = latestOnly === 'true';
      this.logger.debug(
        `Fetching firmware versions for device type: ${deviceType || 'all'}, latest only: ${onlyLatest}`,
      );
      return await this.otaService.getVersions(deviceType, onlyLatest);
    } catch (error) {
      this.logger.error(
        `Failed to get firmware versions: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 上传固件文件（管理员功能）
   */
  @Post('upload')
  @ApiOperation({
    summary: '上传固件文件',
    description: '管理员上传新的固件文件',
  })
  @ApiResponse({ status: 201, description: '上传成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.CREATED)
  async uploadFirmware(
    @Body()
    body: {
      version: string;
      deviceType: string;
      fileUrl: string;
      fileSize: number;
      checksum: string;
      changelog?: string;
    },
  ) {
    try {
      // 验证版本号格式
      if (
        !body.version ||
        body.version.length < 5 ||
        body.version.length > 20
      ) {
        throw new Error('Invalid firmware version format');
      }

      const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
      if (!versionRegex.test(body.version)) {
        throw new Error(
          'Firmware version must be in format: X.Y.Z or X.Y.Z-rcN',
        );
      }

      // 验证设备类型
      const validTypes = ['sleep_lamp', 'sleep_monitor', 'smart_bed'];
      if (!body.deviceType || !validTypes.includes(body.deviceType)) {
        throw new Error(
          `Invalid device type. Must be one of: ${validTypes.join(', ')}`,
        );
      }

      // 验证文件URL
      if (
        !body.fileUrl ||
        body.fileUrl.length < 10 ||
        body.fileUrl.length > 500
      ) {
        throw new Error('Invalid file URL');
      }

      try {
        const url = new URL(body.fileUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('File URL must use HTTP or HTTPS protocol');
        }
      } catch (error) {
        throw new Error('Invalid file URL format');
      }

      // 验证文件大小
      if (
        !body.fileSize ||
        body.fileSize < 1024 ||
        body.fileSize > 10 * 1024 * 1024
      ) {
        throw new Error('File size must be between 1KB and 10MB');
      }

      // 验证校验和
      if (
        !body.checksum ||
        body.checksum.length < 32 ||
        body.checksum.length > 64
      ) {
        throw new Error('Invalid checksum format');
      }

      const checksumRegex = /^[a-fA-F0-9]+$/;
      if (!checksumRegex.test(body.checksum)) {
        throw new Error('Checksum must be a hexadecimal');
      }

      // 验证更新日志长度
      if (body.changelog && body.changelog.length > 2000) {
        throw new Error('Changelog cannot exceed 2000 characters');
      }

      this.logger.log(
        `Uploading firmware version ${body.version} for device type ${body.deviceType}`,
      );
      return await this.otaService.uploadFirmware(body);
    } catch (error) {
      this.logger.error(
        `Failed to upload firmware: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 删除固件版本（管理员功能）
   */
  @Delete('versions/:version')
  @ApiOperation({
    summary: '删除固件版本',
    description: '管理员删除指定的固件版本',
  })
  @ApiParam({ name: 'version', description: '固件版本', example: '1.0.0' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '固件版本不存在' })
  async deleteVersion(@Param('version') version: string) {
    try {
      // 验证版本号格式
      const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/;
      if (!versionRegex.test(version)) {
        throw new Error('Invalid firmware version format');
      }

      this.logger.log(`Deleting firmware version ${version}`);
      return await this.otaService.deleteVersion(version);
    } catch (error) {
      this.logger.error(
        `Failed to delete firmware version: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
