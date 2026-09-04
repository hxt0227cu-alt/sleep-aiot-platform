import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MqttService } from '../mqtt/mqtt.service';
import { DeviceStatusService } from './device-status.service';
import { CreateLightAlarmDto } from './dto/create-light-alarm.dto';
import { UpdateLightAlarmDto } from './dto/update-light-alarm.dto';

type LightAlarmMode = '柔和唤醒' | '强力唤醒' | '助眠模式';

@Injectable()
export class LightAlarmService {
  private readonly logger = new Logger(LightAlarmService.name);
  private readonly lightAlarmModes: Record<
    LightAlarmMode,
    { brightnessTarget: number; colorTempTarget: number }
  > = {
    柔和唤醒: { brightnessTarget: 50, colorTempTarget: 3000 },
    强力唤醒: { brightnessTarget: 100, colorTempTarget: 5200 },
    助眠模式: { brightnessTarget: 15, colorTempTarget: 2700 },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly mqttService: MqttService,
    private readonly deviceStatusService: DeviceStatusService,
  ) {}

  async listByDevice(deviceId: string, userId: string) {
    await this.assertDeviceAccess(deviceId, userId);

    const alarms = await this.prisma.lightAlarm.findMany({
      where: { deviceId, userId },
      orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
    });

    return alarms.map((alarm) => this.toResponse(alarm));
  }

  async create(deviceId: string, userId: string, dto: CreateLightAlarmDto) {
    await this.assertDeviceAccess(deviceId, userId);

    const preset = this.resolveModePreset(dto.mode);
    const alarm = await this.prisma.lightAlarm.create({
      data: {
        deviceId,
        userId,
        time: dto.time,
        mode: dto.mode,
        brightnessTarget: dto.brightnessTarget ?? preset.brightnessTarget,
        colorTempTarget: dto.colorTempTarget ?? preset.colorTempTarget,
        rampMinutes: dto.rampMinutes ?? 15,
        enabled: dto.enabled ?? true,
      },
    });

    await this.syncSchedule(deviceId, userId);
    return this.toResponse(alarm);
  }

  async update(
    deviceId: string,
    alarmId: string,
    userId: string,
    dto: UpdateLightAlarmDto,
  ) {
    await this.assertDeviceAccess(deviceId, userId);
    const alarm = await this.getOwnedAlarm(deviceId, alarmId, userId);

    const mode = dto.mode ?? alarm.mode;
    const preset = this.resolveModePreset(mode);
    const updated = await this.prisma.lightAlarm.update({
      where: { id: alarm.id },
      data: {
        time: dto.time ?? alarm.time,
        mode,
        brightnessTarget: dto.brightnessTarget ?? preset.brightnessTarget,
        colorTempTarget: dto.colorTempTarget ?? preset.colorTempTarget,
        rampMinutes: dto.rampMinutes ?? alarm.rampMinutes,
        enabled: dto.enabled ?? alarm.enabled,
      },
    });

    await this.syncSchedule(deviceId, userId);
    return this.toResponse(updated);
  }

  async updateEnabled(
    deviceId: string,
    alarmId: string,
    userId: string,
    enabled: boolean,
  ) {
    await this.assertDeviceAccess(deviceId, userId);
    const alarm = await this.getOwnedAlarm(deviceId, alarmId, userId);

    const updated = await this.prisma.lightAlarm.update({
      where: { id: alarm.id },
      data: { enabled },
    });

    await this.syncSchedule(deviceId, userId);
    return this.toResponse(updated);
  }

  async remove(deviceId: string, alarmId: string, userId: string) {
    await this.assertDeviceAccess(deviceId, userId);
    const alarm = await this.getOwnedAlarm(deviceId, alarmId, userId);

    await this.prisma.lightAlarm.delete({
      where: { id: alarm.id },
    });

    await this.syncSchedule(deviceId, userId);
    return {
      message: '光闹钟已删除',
      id: alarm.id,
      deviceId,
    };
  }

  private async assertDeviceAccess(deviceId: string, userId: string) {
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权限访问');
    }
  }

  private async getOwnedAlarm(
    deviceId: string,
    alarmId: string,
    userId: string,
  ) {
    const alarm = await this.prisma.lightAlarm.findFirst({
      where: {
        id: alarmId,
        deviceId,
        userId,
      },
    });

    if (!alarm) {
      throw new NotFoundException('光闹钟不存在');
    }

    return alarm;
  }

  private resolveModePreset(mode: string) {
    const preset = this.lightAlarmModes[mode as LightAlarmMode];
    if (!preset) {
      throw new ForbiddenException(`Unsupported light alarm mode: ${mode}`);
    }

    return preset;
  }

  private async syncSchedule(deviceId: string, userId: string) {
    const alarms = await this.prisma.lightAlarm.findMany({
      where: { deviceId, userId },
      orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
    });

    const schedule = {
      executionMode: 'device_local',
      execution_mode: 'device_local',
      rampMinutes: 15,
      ramp_minutes: 15,
      updatedAt: new Date().toISOString(),
      alarms: alarms.map((alarm) => ({
        id: alarm.id,
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
        createdAt: alarm.createdAt.toISOString(),
        updatedAt: alarm.updatedAt.toISOString(),
      })),
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

    const topic = `device/${deviceId}/command`;
    const payload = {
      messageId: `alarm_cfg_${Date.now()}`,
      type: 'command',
      command: 'alarm_config',
      params: {
        configKey: 'light_alarm_schedule',
        schedule,
      },
      timestamp: Date.now(),
      deviceId,
      userId,
    };

    this.logger.log(`Syncing light alarm schedule to device ${deviceId}`);
    await this.mqttService.publish(topic, JSON.stringify(payload));
  }

  private toResponse(alarm: any) {
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
}
