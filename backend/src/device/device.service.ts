import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttService } from '../mqtt/mqtt.service';
import { DeviceStatusService } from './device-status.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { BindDeviceDto } from './dto/bind-device.dto';
import { DeviceCommandDto } from './dto/device-command.dto';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { CompleteProvisioningDto } from './dto/complete-provisioning.dto';
import { randomBytes } from 'crypto';

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  private readonly BINDING_CODE_EXPIRY = 600;
  private readonly PROVISIONING_TOKEN_EXPIRY = 600;
  private readonly COMMAND_TIMEOUT = 30000;

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
    private mqttService: MqttService,
    private deviceStatusService: DeviceStatusService,
  ) {}

  async register(registerDeviceDto: RegisterDeviceDto) {
    const {
      deviceId,
      deviceName,
      deviceType,
      firmwareVersion,
      macAddress,
      chipId,
      psramSize,
    } = registerDeviceDto;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.BINDING_CODE_EXPIRY * 1000);

    this.logger.log(`Device registration request: ${deviceId}`);

    if (macAddress) {
      const deviceByMac = await this.prisma.device.findUnique({
        where: { macAddress },
      });
      if (deviceByMac && deviceByMac.id !== deviceId) {
        throw new ConflictException('该 MAC 地址已绑定到其他设备');
      }
    }

    const device = await this.prisma.device.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        name: deviceName,
        type: deviceType || 'sleep_lamp',
        firmwareVersion,
        macAddress,
        chipId,
        psramSize,
        lastSeen: now,
        status: 'online',
      },
      update: {
        name: deviceName,
        type: deviceType || 'sleep_lamp',
        firmwareVersion,
        macAddress,
        chipId,
        psramSize,
        lastSeen: now,
        status: 'online',
      },
    });

    const bindingCode = this.generateBindingCode();
    await this.redisService.set(
      `binding_code:${deviceId}`,
      bindingCode,
      this.BINDING_CODE_EXPIRY,
    );

    await this.prisma.deviceBindingSession.updateMany({
      where: {
        deviceId,
        sessionType: 'manual',
        status: 'pending',
      },
      data: {
        status: 'expired',
        expiresAt: now,
      },
    });

    await this.prisma.deviceBindingSession.create({
      data: {
        deviceId,
        bindingCode,
        sessionType: 'manual',
        status: 'pending',
        expiresAt,
        requestMetadata: {
          firmwareVersion: firmwareVersion || null,
          macAddress: macAddress || null,
          chipId: chipId || null,
          psramSize: psramSize || null,
        },
      },
    });

    await this.deviceStatusService.updateDeviceStatus(deviceId, {
      firmwareVersion,
    });

    return {
      deviceId: device.id,
      device_id: device.id,
      bindingCode,
      binding_code: bindingCode,
      expiresIn: this.BINDING_CODE_EXPIRY,
      expires_in: this.BINDING_CODE_EXPIRY,
      mqttConfig: {
        broker: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        port: '1883',
        username: device.id,
        password: bindingCode,
      },
      mqtt_config: {
        broker: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        port: '1883',
        username: device.id,
        password: bindingCode,
      },
    };
  }

  async bind(userId: string, bindDeviceDto: BindDeviceDto) {
    const deviceId = bindDeviceDto.deviceId?.trim();
    const bindingCode = bindDeviceDto.bindingCode?.trim();
    const now = new Date();

    this.logger.log(`User ${userId} attempting to bind device ${deviceId}`);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) {
      throw new NotFoundException('设备不存在');
    }

    const existingOwner = await this.prisma.userDevice.findFirst({
      where: { deviceId },
    });
    if (existingOwner) {
      if (existingOwner.userId === userId) {
        return this.buildBoundResponse(device, '设备已绑定到当前账号');
      }
      throw new ConflictException('设备已绑定到其他账号');
    }

    let bindingSession = await this.prisma.deviceBindingSession.findFirst({
      where: {
        deviceId,
        bindingCode,
        sessionType: 'manual',
        status: 'pending',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    const storedCode = await this.redisService.get(`binding_code:${deviceId}`);
    if (!bindingSession && storedCode === bindingCode) {
      bindingSession = await this.prisma.deviceBindingSession.create({
        data: {
          deviceId,
          bindingCode,
          sessionType: 'manual',
          status: 'pending',
          expiresAt: new Date(now.getTime() + this.BINDING_CODE_EXPIRY * 1000),
          requestMetadata: {
            source: 'redis_fallback',
          },
        },
      });
    }

    if (!bindingSession) {
      throw new ForbiddenException('绑定码无效或已过期');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userDevice.create({
        data: {
          userId,
          deviceId,
          bindingCode,
          role: 'owner',
          // 事务内 $extends 不生效，显式继承设备租户（未租户化则保持 NULL）
          tenantId: device.tenantId ?? undefined,
        },
      });

      await tx.deviceBindingSession.update({
        where: { id: bindingSession.id },
        data: {
          userId,
          status: 'completed',
          tenantId: device.tenantId ?? undefined,
          completedAt: now,
        },
      });
    });

    await this.redisService.del(`binding_code:${deviceId}`);

    return this.buildBoundResponse(device);
  }

  async createProvisioningToken(userId: string) {
    const bindToken = `prov_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    const expiresAt = new Date(now + this.PROVISIONING_TOKEN_EXPIRY * 1000);

    const tokenRecord = await this.prisma.deviceProvisionToken.create({
      data: {
        token: bindToken,
        userId,
        status: 'pending',
        expiresAt,
        metadata: {
          source: 'miniprogram',
          createdAt: now,
        },
      },
    });

    await this.redisService.set(
      `provision_token:${bindToken}`,
      JSON.stringify({
        provisionTokenId: tokenRecord.id,
        userId,
        createdAt: now,
        expiresAt: expiresAt.getTime(),
      }),
      this.PROVISIONING_TOKEN_EXPIRY,
    );

    return {
      bindToken,
      bind_token: bindToken,
      expiresIn: this.PROVISIONING_TOKEN_EXPIRY,
      expires_in: this.PROVISIONING_TOKEN_EXPIRY,
    };
  }

  async rememberProvisionedDevice(deviceId: string, bindToken: string) {
    if (!bindToken || !bindToken.startsWith('prov_')) {
      return;
    }

    const now = new Date();
    await this.redisService.set(
      `provision_device:${bindToken}`,
      JSON.stringify({ deviceId, onlineAt: now.getTime() }),
      this.PROVISIONING_TOKEN_EXPIRY,
    );

    const tokenRecord = await this.getProvisionTokenRecord(bindToken);
    if (!tokenRecord) {
      this.logger.warn(
        `Provisioning token ${bindToken.slice(0, 12)} not found when remembering device`,
      );
      return;
    }

    await this.prisma.deviceProvisionToken.update({
      where: { id: tokenRecord.id },
      data: {
        deviceId,
        status:
          tokenRecord.status === 'completed' ? tokenRecord.status : 'claimed',
        claimedAt: tokenRecord.claimedAt || now,
      },
    });

    await this.prisma.deviceBindingSession.upsert({
      where: { provisionTokenId: tokenRecord.id },
      create: {
        userId: tokenRecord.userId,
        deviceId,
        provisionTokenId: tokenRecord.id,
        sessionType: 'provisioning',
        status:
          tokenRecord.status === 'completed' ? 'completed' : 'device_online',
        expiresAt: tokenRecord.expiresAt,
        completedAt:
          tokenRecord.status === 'completed'
            ? tokenRecord.completedAt || now
            : null,
        requestMetadata: {
          bindToken,
          onlineAt: now.toISOString(),
        },
      },
      update: {
        deviceId,
        status:
          tokenRecord.status === 'completed' ? 'completed' : 'device_online',
        expiresAt: tokenRecord.expiresAt,
        requestMetadata: {
          bindToken,
          onlineAt: now.toISOString(),
        },
      },
    });

    this.logger.log(
      `Provisioning token ${bindToken.slice(0, 12)}... reported by ${deviceId}`,
    );
  }

  async completeProvisioning(userId: string, dto: CompleteProvisioningDto) {
    const bindToken = dto.bindToken?.trim();
    const requestedDeviceId = dto.deviceId?.trim();
    const now = new Date();

    if (!bindToken) {
      throw new BadRequestException('bindToken is required');
    }

    const tokenRecord = await this.getProvisionTokenRecord(bindToken);
    if (!tokenRecord) {
      throw new ForbiddenException('配网绑定 token 无效或已过期');
    }

    if (tokenRecord.userId !== userId) {
      throw new ForbiddenException('配网绑定 token 不属于当前用户');
    }

    if (tokenRecord.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.deviceProvisionToken.update({
        where: { id: tokenRecord.id },
        data: { status: 'expired' },
      });
      throw new ForbiddenException('配网绑定 token 无效或已过期');
    }

    const provisionedDeviceId = await this.resolveProvisionedDeviceId(
      bindToken,
      requestedDeviceId,
      tokenRecord.deviceId || undefined,
    );

    if (!provisionedDeviceId) {
      throw new BadRequestException(
        '设备尚未上线，请确认 WiFi 密码、2.4G 路由器和 MQTT 连接',
      );
    }

    const device = await this.prisma.device.findUnique({
      where: { id: provisionedDeviceId },
    });
    if (!device) {
      throw new NotFoundException('设备尚未注册上线');
    }

    const existingOwner = await this.prisma.userDevice.findFirst({
      where: { deviceId: provisionedDeviceId },
    });
    if (existingOwner && existingOwner.userId !== userId) {
      throw new ConflictException('设备已绑定到其他账号');
    }

    await this.prisma.$transaction(async (tx) => {
      if (!existingOwner) {
        await tx.userDevice.create({
          data: {
            userId,
            deviceId: provisionedDeviceId,
            bindingCode: bindToken.slice(0, 32),
            role: 'owner',
            // 事务内 $extends 不生效，显式继承设备租户
            tenantId: device.tenantId ?? undefined,
          },
        });
      }

      await tx.deviceProvisionToken.update({
        where: { id: tokenRecord.id },
        data: {
          deviceId: provisionedDeviceId,
          status: 'completed',
          claimedAt: tokenRecord.claimedAt || now,
          completedAt: now,
          metadata: {
            ...(this.asPlainObject(tokenRecord.metadata) || {}),
            completedBy: userId,
            completedAt: now.toISOString(),
          },
        },
      });

      await tx.deviceBindingSession.upsert({
        where: { provisionTokenId: tokenRecord.id },
        create: {
          userId,
          deviceId: provisionedDeviceId,
          provisionTokenId: tokenRecord.id,
          sessionType: 'provisioning',
          status: 'completed',
          expiresAt: tokenRecord.expiresAt,
          completedAt: now,
          tenantId: device.tenantId ?? undefined,
          requestMetadata: {
            bindToken,
            requestedDeviceId: requestedDeviceId || null,
          },
        },
        update: {
          userId,
          deviceId: provisionedDeviceId,
          status: 'completed',
          expiresAt: tokenRecord.expiresAt,
          completedAt: now,
          tenantId: device.tenantId ?? undefined,
          requestMetadata: {
            bindToken,
            requestedDeviceId: requestedDeviceId || null,
          },
        },
      });
    });

    await this.redisService.del(`provision_token:${bindToken}`);
    await this.redisService.del(`provision_device:${bindToken}`);

    return {
      message: existingOwner ? '设备已绑定到当前账号' : '设备配网并绑定成功',
      deviceId: device.id,
      device_id: device.id,
      deviceName: device.name,
      device_name: device.name,
      bindingStatus: 'bound',
      binding_status: 'bound',
    };
  }

  async unbind(userId: string, deviceId: string) {
    this.logger.log(`User ${userId} attempting to unbind device ${deviceId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { userId, deviceId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备未绑定');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.userDevice.delete({
        where: { id: userDevice.id },
      });

      await tx.lightAlarm.deleteMany({
        where: { userId, deviceId },
      });

      await tx.deviceBindingSession.create({
        data: {
          userId,
          deviceId,
          sessionType: 'unbind',
          status: 'unbound',
          completedAt: now,
          unboundAt: now,
          // 事务内 $extends 不生效，显式继承绑定行租户
          tenantId: userDevice.tenantId ?? undefined,
        },
      });
    });

    await this.replaceLightAlarmSchedule(deviceId, []);

    return {
      message: '设备解绑成功',
      deviceId,
      device_id: deviceId,
    };
  }

  async findAllByUserId(userId: string) {
    this.logger.debug(`Fetching devices for user ${userId}`);

    const userDevices = await this.prisma.userDevice.findMany({
      where: { userId },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });

    const devices = await Promise.all(
      userDevices.map(async (userDevice) => {
        const [status, lightConfig, lightAlarms] = await Promise.all([
          this.deviceStatusService.getDeviceStatus(userDevice.deviceId),
          this.prisma.deviceConfig.findUnique({
            where: {
              deviceId_configKey: {
                deviceId: userDevice.deviceId,
                configKey: 'light_state',
              },
            },
          }),
          this.prisma.lightAlarm.findMany({
            where: { deviceId: userDevice.deviceId, userId },
            orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
          }),
        ]);

        const normalizedLightState = this.normalizeLightState(
          lightConfig?.configValue as any,
        );
        const normalizedLightAlarms = lightAlarms.map((alarm) =>
          this.toLightAlarmResponse(alarm),
        );

        return {
          deviceId: userDevice.device.id,
          device_id: userDevice.device.id,
          deviceName: userDevice.device.name,
          device_name: userDevice.device.name,
          deviceType: userDevice.device.type,
          device_type: userDevice.device.type,
          online: status?.online || false,
          lastSeen:
            status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
          last_seen:
            status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
          firmwareVersion: userDevice.device.firmwareVersion,
          firmware_version: userDevice.device.firmwareVersion,
          location: userDevice.device.location,
          role: userDevice.role,
          bindingStatus: 'bound',
          binding_status: 'bound',
          boundAt: userDevice.createdAt.getTime(),
          bound_at: userDevice.createdAt.getTime(),
          light: normalizedLightState,
          light_state: normalizedLightState,
          status: {
            online: status?.online || false,
            last_seen:
              status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
            firmware_version: userDevice.device.firmwareVersion,
            light: normalizedLightState
              ? {
                  power: normalizedLightState.power,
                  brightness: normalizedLightState.brightness,
                  color_temp: normalizedLightState.colorTemp,
                  colorTemp: normalizedLightState.colorTemp,
                }
              : undefined,
            light_alarms: normalizedLightAlarms,
          },
        };
      }),
    );

    return devices;
  }

  async findOne(deviceId: string, userId: string) {
    this.logger.debug(`Fetching device ${deviceId} for user ${userId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
      include: { device: true },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const [status, deviceConfig, lightAlarms] = await Promise.all([
      this.deviceStatusService.getDeviceStatus(deviceId),
      this.prisma.deviceConfig.findMany({
        where: { deviceId },
      }),
      this.prisma.lightAlarm.findMany({
        where: { deviceId, userId },
        orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const config = deviceConfig.reduce(
      (acc, item) => {
        acc[item.configKey] = item.configValue;
        return acc;
      },
      {} as Record<string, any>,
    );
    const normalizedLightState = this.normalizeLightState(config.light_state);
    const normalizedLightAlarms = lightAlarms.map((alarm) =>
      this.toLightAlarmResponse(alarm),
    );

    return {
      deviceId: userDevice.device.id,
      device_id: userDevice.device.id,
      deviceName: userDevice.device.name,
      device_name: userDevice.device.name,
      deviceType: userDevice.device.type,
      device_type: userDevice.device.type,
      online: status?.online || false,
      lastSeen: status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
      last_seen: status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
      firmwareVersion: userDevice.device.firmwareVersion,
      firmware_version: userDevice.device.firmwareVersion,
      hardwareInfo: {
        chipId: userDevice.device.chipId,
        macAddress: userDevice.device.macAddress,
        psramSize: userDevice.device.psramSize,
      },
      hardware_info: {
        chip_id: userDevice.device.chipId,
        mac_address: userDevice.device.macAddress,
        psram_size: userDevice.device.psramSize,
      },
      location: userDevice.device.location,
      role: userDevice.role,
      bindingStatus: 'bound',
      binding_status: 'bound',
      boundAt: userDevice.createdAt.getTime(),
      bound_at: userDevice.createdAt.getTime(),
      light: normalizedLightState,
      light_state: normalizedLightState,
      status: {
        online: status?.online || false,
        last_seen:
          status?.lastSeen || userDevice.device.lastSeen?.getTime() || 0,
        firmware_version: userDevice.device.firmwareVersion,
        light: normalizedLightState
          ? {
              power: normalizedLightState.power,
              brightness: normalizedLightState.brightness,
              color_temp: normalizedLightState.colorTemp,
              colorTemp: normalizedLightState.colorTemp,
            }
          : undefined,
        light_alarms: normalizedLightAlarms,
      },
      config,
    };
  }

  async sendCommand(
    deviceId: string,
    userId: string,
    commandDto: DeviceCommandDto,
  ) {
    this.logger.log(
      `Sending command ${commandDto.command} to device ${deviceId} by user ${userId}`,
    );

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) {
      throw new NotFoundException('设备不存在');
    }

    const deviceStatus =
      await this.deviceStatusService.getDeviceStatus(deviceId);
    if (!deviceStatus?.online) {
      throw new ForbiddenException('设备离线，无法发送指令');
    }

    const commandId = `cmd_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const timeout = commandDto.timeout || this.COMMAND_TIMEOUT;
    const topic = `device/${deviceId}/command`;
    const commandPayload = {
      messageId: commandId,
      commandId,
      type: 'command',
      command: commandDto.command,
      params: commandDto.params,
      timestamp: Date.now(),
      deviceId,
      userId,
    };

    await this.prisma.deviceCommandRecord.create({
      data: {
        commandId,
        deviceId,
        userId,
        command: commandDto.command,
        params: commandDto.params || {},
        status: 'pending',
        topic,
        timeoutMs: timeout,
        sentAt: new Date(commandPayload.timestamp),
      },
    });

    try {
      await this.mqttService.publish(topic, JSON.stringify(commandPayload));
      const response = await this.waitForCommandResponse(commandId, timeout);

      if (!response) {
        await this.prisma.deviceCommandRecord.updateMany({
          where: { commandId, status: 'pending' },
          data: {
            status: 'timeout',
            errorMessage: '指令执行超时',
          },
        });
        throw new BadRequestException('指令执行超时');
      }

      if (response.status !== 'success') {
        throw new BadRequestException(
          response.error || response.result?.message || '指令执行失败',
        );
      }

      return {
        commandId,
        command_id: commandId,
        status: 'success',
        result: response.result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '指令执行失败';

      await this.prisma.deviceCommandRecord.updateMany({
        where: {
          commandId,
          status: {
            in: ['pending'],
          },
        },
        data: {
          status: errorMessage.includes('超时') ? 'timeout' : 'failed',
          errorMessage,
        },
      });

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(`指令执行失败: ${errorMessage}`);
    }
  }

  async create(createDeviceDto: CreateDeviceDto) {
    this.logger.log(`Creating device: ${createDeviceDto.name}`);

    if (createDeviceDto.macAddress) {
      const existingDevice = await this.prisma.device.findUnique({
        where: { macAddress: createDeviceDto.macAddress },
      });
      if (existingDevice) {
        throw new BadRequestException('该 MAC 地址的设备已存在');
      }
    }

    const device = await this.prisma.device.create({
      data: {
        name: createDeviceDto.name,
        type: 'sleep_lamp',
        macAddress: createDeviceDto.macAddress,
        location: createDeviceDto.location,
        status: 'offline',
      },
    });

    return {
      deviceId: device.id,
      device_id: device.id,
      deviceName: device.name,
      device_name: device.name,
      macAddress: device.macAddress,
      mac_address: device.macAddress,
      location: device.location,
      status: device.status,
      createdAt: device.createdAt.getTime(),
      created_at: device.createdAt.getTime(),
    };
  }

  async update(
    deviceId: string,
    userId: string,
    updateDeviceDto: UpdateDeviceDto,
  ) {
    this.logger.log(`Updating device ${deviceId} by user ${userId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const device = await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        ...(updateDeviceDto.name && { name: updateDeviceDto.name }),
        ...(updateDeviceDto.location !== undefined && {
          location: updateDeviceDto.location,
        }),
      },
    });

    return {
      deviceId: device.id,
      device_id: device.id,
      deviceName: device.name,
      device_name: device.name,
      location: device.location,
      updatedAt: device.updatedAt.getTime(),
      updated_at: device.updatedAt.getTime(),
    };
  }

  async remove(deviceId: string) {
    this.logger.log(`Deleting device ${deviceId}`);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) {
      throw new NotFoundException('设备不存在');
    }

    await this.prisma.device.delete({
      where: { id: deviceId },
    });

    await this.deviceStatusService.clearDeviceStatus(deviceId);

    return {
      message: '设备删除成功',
      deviceId,
      device_id: deviceId,
    };
  }

  async getOnlineStatus(deviceId: string, userId: string) {
    this.logger.debug(`Checking online status for device ${deviceId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const [status, lightConfig, lightAlarms] = await Promise.all([
      this.deviceStatusService.getDeviceStatus(deviceId),
      this.prisma.deviceConfig.findUnique({
        where: {
          deviceId_configKey: { deviceId, configKey: 'light_state' },
        },
      }),
      this.prisma.lightAlarm.findMany({
        where: { deviceId, userId },
        orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const normalizedLightState = this.normalizeLightState(
      lightConfig?.configValue as any,
    );

    return {
      deviceId,
      device_id: deviceId,
      online: status?.online || false,
      lastSeen: status?.lastSeen || 0,
      last_seen: status?.lastSeen || 0,
      status: status?.status || 'unknown',
      firmwareVersion: status?.firmwareVersion,
      firmware_version: status?.firmwareVersion,
      light: normalizedLightState,
      light_state: normalizedLightState,
      light_alarms: lightAlarms.map((alarm) =>
        this.toLightAlarmResponse(alarm),
      ),
    };
  }

  async getBatchOnlineStatus(deviceIds: string[], userId: string) {
    this.logger.debug(
      `Checking batch online status for ${deviceIds.length} devices`,
    );

    const userDevices = await this.prisma.userDevice.findMany({
      where: {
        userId,
        deviceId: { in: deviceIds },
      },
    });

    const accessibleDeviceIds = userDevices.map((item) => item.deviceId);
    return Promise.all(
      accessibleDeviceIds.map(async (deviceId) => {
        const status = await this.deviceStatusService.getDeviceStatus(deviceId);
        return {
          deviceId,
          device_id: deviceId,
          online: status?.online || false,
          lastSeen: status?.lastSeen || 0,
          last_seen: status?.lastSeen || 0,
          status: status?.status || 'unknown',
        };
      }),
    );
  }

  async updateConfig(
    deviceId: string,
    userId: string,
    config: Record<string, any>,
  ) {
    this.logger.log(`Updating config for device ${deviceId} by user ${userId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    await Promise.all(
      Object.entries(config).map(([key, value]) =>
        this.prisma.deviceConfig.upsert({
          where: { deviceId_configKey: { deviceId, configKey: key } },
          update: { configValue: value },
          create: { deviceId, configKey: key, configValue: value },
        }),
      ),
    );

    return {
      message: '设备配置更新成功',
      deviceId,
      device_id: deviceId,
      config,
    };
  }

  async getConfig(deviceId: string, userId: string) {
    this.logger.debug(`Fetching config for device ${deviceId}`);

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const deviceConfig = await this.prisma.deviceConfig.findMany({
      where: { deviceId },
    });

    const config = deviceConfig.reduce(
      (acc, item) => {
        acc[item.configKey] = item.configValue;
        return acc;
      },
      {} as Record<string, any>,
    );
    const normalizedLightState = this.normalizeLightState(config.light_state);

    return {
      deviceId,
      device_id: deviceId,
      light: normalizedLightState,
      light_state: normalizedLightState,
      config,
    };
  }

  async refreshBindingCode(deviceId: string, userId: string) {
    this.logger.log(
      `Refreshing binding code for device ${deviceId} by user ${userId}`,
    );

    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });
    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权访问');
    }

    const bindingCode = this.generateBindingCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.BINDING_CODE_EXPIRY * 1000);

    await this.redisService.set(
      `binding_code:${deviceId}`,
      bindingCode,
      this.BINDING_CODE_EXPIRY,
    );

    await this.prisma.deviceBindingSession.create({
      data: {
        userId,
        deviceId,
        bindingCode,
        sessionType: 'manual',
        status: 'pending',
        expiresAt,
        requestMetadata: {
          refreshedBy: userId,
        },
      },
    });

    return {
      deviceId,
      device_id: deviceId,
      bindingCode,
      binding_code: bindingCode,
      expiry: this.BINDING_CODE_EXPIRY,
      expiresIn: this.BINDING_CODE_EXPIRY,
      expires_in: this.BINDING_CODE_EXPIRY,
    };
  }

  async getDeviceStats(userId: string) {
    this.logger.debug(`Fetching device stats for user ${userId}`);

    const userDevices = await this.prisma.userDevice.findMany({
      where: { userId },
      include: { device: true },
    });

    let onlineCount = 0;
    for (const userDevice of userDevices) {
      const status = await this.deviceStatusService.getDeviceStatus(
        userDevice.deviceId,
      );
      if (status?.online) {
        onlineCount += 1;
      }
    }

    const totalDevices = userDevices.length;
    const offlineCount = totalDevices - onlineCount;

    return {
      totalDevices,
      total_devices: totalDevices,
      onlineCount,
      online_count: onlineCount,
      offlineCount,
      offline_count: offlineCount,
      onlineRate:
        totalDevices > 0
          ? ((onlineCount / totalDevices) * 100).toFixed(2)
          : '0.00',
      online_rate:
        totalDevices > 0
          ? ((onlineCount / totalDevices) * 100).toFixed(2)
          : '0.00',
    };
  }

  private async getProvisionTokenRecord(bindToken: string) {
    let tokenRecord = await this.prisma.deviceProvisionToken.findUnique({
      where: { token: bindToken },
    });

    if (tokenRecord) {
      return tokenRecord;
    }

    const redisPayload = await this.redisService.get(
      `provision_token:${bindToken}`,
    );
    if (!redisPayload) {
      return null;
    }

    const parsed = JSON.parse(redisPayload) as {
      provisionTokenId?: string;
      userId: string;
      createdAt?: number;
      expiresAt?: number;
    };
    const createdAt = Number(parsed.createdAt) || Date.now();
    const expiresAt =
      Number(parsed.expiresAt) ||
      createdAt + this.PROVISIONING_TOKEN_EXPIRY * 1000;

    tokenRecord = await this.prisma.deviceProvisionToken.create({
      data: {
        token: bindToken,
        userId: parsed.userId,
        status: 'pending',
        expiresAt: new Date(expiresAt),
        metadata: {
          source: 'redis_recovered',
          createdAt,
        },
      },
    });

    return tokenRecord;
  }

  private async resolveProvisionedDeviceId(
    bindToken: string,
    requestedDeviceId?: string,
    persistedDeviceId?: string,
  ) {
    const redisPayload = await this.redisService.get(
      `provision_device:${bindToken}`,
    );
    const redisDeviceId = redisPayload
      ? (JSON.parse(redisPayload) as { deviceId?: string }).deviceId
      : undefined;

    if (
      requestedDeviceId &&
      redisDeviceId &&
      requestedDeviceId !== redisDeviceId
    ) {
      throw new BadRequestException('设备上线信息与绑定请求不一致');
    }

    if (
      requestedDeviceId &&
      persistedDeviceId &&
      requestedDeviceId !== persistedDeviceId
    ) {
      throw new BadRequestException('设备上线信息与绑定请求不一致');
    }

    return requestedDeviceId || persistedDeviceId || redisDeviceId;
  }

  private buildBoundResponse(
    device: { id: string; name: string },
    message = '设备绑定成功',
  ) {
    return {
      message,
      deviceId: device.id,
      device_id: device.id,
      deviceName: device.name,
      device_name: device.name,
      bindingStatus: 'bound',
      binding_status: 'bound',
    };
  }

  private generateBindingCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private normalizeLightState(lightState: any) {
    if (!lightState || typeof lightState !== 'object') {
      return null;
    }

    return {
      power: Boolean(lightState.power ?? lightState.on),
      brightness: Number(lightState.brightness ?? 0),
      colorTemp: Number(lightState.colorTemp ?? lightState.color_temp ?? 4000),
    };
  }

  private async waitForCommandResponse(commandId: string, timeout: number) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const redisResponse = await this.redisService.get(
        `command_response:${commandId}`,
      );
      if (redisResponse) {
        await this.redisService.del(`command_response:${commandId}`);
        return JSON.parse(redisResponse) as {
          status: 'success' | 'error' | 'timeout';
          result?: any;
          error?: string;
        };
      }

      const commandRecord = await this.prisma.deviceCommandRecord.findUnique({
        where: { commandId },
      });
      if (commandRecord && commandRecord.status !== 'pending') {
        return {
          status: this.commandRecordStatusToResponseStatus(
            commandRecord.status,
          ),
          result: this.asPlainObject(commandRecord.response),
          error: commandRecord.errorMessage || undefined,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    return null;
  }

  private commandRecordStatusToResponseStatus(status: string) {
    if (status === 'success') {
      return 'success' as const;
    }
    if (status === 'timeout') {
      return 'timeout' as const;
    }
    return 'error' as const;
  }

  private toLightAlarmResponse(alarm: any) {
    return {
      id: alarm.id,
      alarmId: alarm.id,
      alarm_id: alarm.id,
      deviceId: alarm.deviceId,
      device_id: alarm.deviceId,
      time: alarm.time,
      mode: alarm.mode,
      brightnessTarget: alarm.brightnessTarget,
      brightness_target: alarm.brightnessTarget,
      colorTempTarget: alarm.colorTempTarget,
      color_temp_target: alarm.colorTempTarget,
      enabled: alarm.enabled,
      rampMinutes: alarm.rampMinutes,
      ramp_minutes: alarm.rampMinutes,
      createdAt: alarm.createdAt,
      created_at: alarm.createdAt,
      updatedAt: alarm.updatedAt,
      updated_at: alarm.updatedAt,
    };
  }

  private async replaceLightAlarmSchedule(deviceId: string, alarms: any[]) {
    const schedule = {
      executionMode: 'device_local',
      execution_mode: 'device_local',
      rampMinutes: 15,
      ramp_minutes: 15,
      updatedAt: new Date().toISOString(),
      alarms,
    };

    await this.prisma.deviceConfig.upsert({
      where: {
        deviceId_configKey: {
          deviceId,
          configKey: 'light_alarm_schedule',
        },
      },
      create: {
        deviceId,
        configKey: 'light_alarm_schedule',
        configValue: schedule,
      },
      update: {
        configValue: schedule,
      },
    });

    await this.redisService.set(
      `light_alarm_schedule:${deviceId}`,
      JSON.stringify(schedule),
      3600,
    );

    const deviceStatus =
      await this.deviceStatusService.getDeviceStatus(deviceId);
    if (!deviceStatus?.online) {
      return;
    }

    await this.mqttService.publish(
      `device/${deviceId}/command`,
      JSON.stringify({
        messageId: `alarm_cfg_${Date.now()}`,
        type: 'command',
        command: 'alarm_config',
        params: {
          configKey: 'light_alarm_schedule',
          schedule,
        },
        timestamp: Date.now(),
        deviceId,
        userId: 'system',
      }),
    );
  }

  private asPlainObject(value: any) {
    if (!value || typeof value !== 'object') {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }
}
