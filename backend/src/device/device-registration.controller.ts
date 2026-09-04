import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DeviceService } from './device.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@ApiTags('设备接入')
@Controller('devices')
export class DeviceRegistrationController {
  private readonly logger = new Logger(DeviceRegistrationController.name);

  constructor(private readonly deviceService: DeviceService) {}

  @Post('register')
  @ApiOperation({
    summary: '设备注册',
    description: '设备首次启动时调用，登记设备信息并生成短时绑定码',
  })
  @ApiResponse({ status: 201, description: '设备注册成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(new ValidationPipe({ transform: true }))
    registerDeviceDto: RegisterDeviceDto,
  ) {
    try {
      this.logger.log(
        `Device registration request: ${registerDeviceDto.deviceId}`,
      );
      return await this.deviceService.register(registerDeviceDto);
    } catch (error) {
      this.logger.error(
        `Device registration failed: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
