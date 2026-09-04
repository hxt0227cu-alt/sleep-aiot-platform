import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WebSocketService } from '../websocket/websocket.service';
import { AlarmService } from '../alarm/alarm.service';
import { R60ABD1ParserService, R60ABD1Data } from './r60abd1-parser.service';

@Injectable()
export class DataProcessorService {
  private readonly logger = new Logger(DataProcessorService.name);
  private readonly DATA_RETENTION_DAYS = 90;

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
    private wsService: WebSocketService,
    private alarmService: AlarmService,
    private r60abd1Parser: R60ABD1ParserService,
  ) {}

  private async requireDeviceTenant(deviceId: string): Promise<string> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId },
      select: { tenantId: true },
    });
    if (!device?.tenantId) {
      throw new Error(`Device ${deviceId} has no tenant assignment`);
    }
    return device.tenantId;
  }

  async processVitalSigns(deviceId: string, data: any) {
    try {
      if (!this.r60abd1Parser.validateR60ABD1Data(data)) {
        this.logger.warn(`Invalid R60ABD1 data for device ${deviceId}`);
        return;
      }

      const parsedData = this.r60abd1Parser.parseR60ABD1Data(deviceId, data);

      const {
        heartRate,
        breathingRate,
        bodyMovement,
        sleepState,
        sleepScore,
        confidence,
        timestamp,
        presence,
        distance,
      } = parsedData;

      const hasAnyRadarData = [
        heartRate,
        breathingRate,
        bodyMovement,
        sleepState,
        sleepScore,
        confidence,
        presence,
        distance,
      ].some((value) => value !== undefined && value !== null);

      if (!hasAnyRadarData) {
        this.logger.debug(
          `No usable R60ABD1 metrics yet for device ${deviceId}, skip vital sign insert`,
        );
        return;
      }

      const normalizedSleepState = sleepState
        ? this.r60abd1Parser.normalizeSleepState(sleepState)
        : undefined;
      const calculatedSleepScore =
        sleepScore ??
        (heartRate !== undefined ||
        breathingRate !== undefined ||
        bodyMovement !== undefined
          ? this.r60abd1Parser.calculateSleepQuality(
              heartRate ?? 70,
              breathingRate ?? 16,
              bodyMovement ?? 10,
            )
          : undefined);

      const tenantId = await this.requireDeviceTenant(deviceId);
      const vitalSignsData = await this.prisma.vitalSignsData.create({
        data: {
          tenantId,
          deviceId,
          timestamp: new Date(timestamp),
          heartRate,
          breathingRate,
          bodyMovement,
          sleepState: normalizedSleepState,
          sleepScore: calculatedSleepScore,
          confidence,
          rawData: data,
        },
      });

      if (
        heartRate !== undefined &&
        breathingRate !== undefined &&
        bodyMovement !== undefined
      ) {
        const alarms = await this.alarmService.checkAlarmRules(deviceId, {
          deviceId,
          timestamp: new Date(timestamp),
          heartRate,
          breathingRate,
          bodyMovement,
          sleepState: normalizedSleepState,
        });

        for (const alarm of alarms) {
          this.wsService.sendAlarm(deviceId, {
            alarmId: alarm.id,
            deviceId,
            type: alarm.type,
            level: alarm.level,
            message: alarm.message,
            value: Number(alarm.value),
            threshold: Number(alarm.threshold),
            timestamp: alarm.timestamp.getTime(),
            status: alarm.status,
          });
        }
      }

      this.logger.debug(`Processed vital signs for device ${deviceId}`);
    } catch (error) {
      this.logger.error(
        `Error processing vital signs for device ${deviceId}:`,
        error,
      );
    }
  }

  async processSleepState(deviceId: string, data: any) {
    try {
      const { state, duration, confidence, timestamp = new Date() } = data;

      const tenantId = await this.requireDeviceTenant(deviceId);
      await this.prisma.sleepStateData.create({
        data: {
          tenantId,
          deviceId,
          timestamp: new Date(timestamp),
          state,
          duration,
          confidence,
        },
      });

      this.logger.debug(
        `Processed sleep state for device ${deviceId}: ${state}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing sleep state for device ${deviceId}:`,
        error,
      );
    }
  }

  async processDeviceStatus(deviceId: string, data: any) {
    try {
      const { online, status, timestamp = new Date() } = data;

      await this.prisma.device.update({
        where: { id: deviceId },
        data: {
          status: online ? 'online' : 'offline',
          lastSeen: new Date(timestamp),
        },
      });

      this.wsService.sendDeviceStatus(deviceId, online);

      this.logger.debug(
        `Processed device status for ${deviceId}: ${online ? 'online' : 'offline'}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing device status for ${deviceId}:`,
        error,
      );
    }
  }

  async processCommandResponse(deviceId: string, data: any) {
    try {
      const { commandId, status, result, timestamp = new Date() } = data;

      await this.redisService.set(
        `command_response:${commandId}`,
        JSON.stringify({
          commandId,
          status,
          result,
          timestamp: new Date(timestamp).getTime(),
        }),
        60,
      );

      this.wsService.sendCommandResponse(deviceId, {
        commandId,
        deviceId,
        status,
        result,
        timestamp: new Date(timestamp).getTime(),
      });

      this.logger.debug(
        `Processed command response for device ${deviceId}: ${commandId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing command response for device ${deviceId}:`,
        error,
      );
    }
  }

  async processOtaProgress(deviceId: string, data: any) {
    try {
      const { version, progress, status, timestamp = new Date() } = data;

      await this.prisma.deviceConfig.upsert({
        where: { deviceId_configKey: { deviceId, configKey: 'ota_progress' } },
        create: {
          deviceId,
          configKey: 'ota_progress',
          configValue: {
            version,
            progress,
            status,
            timestamp: new Date(timestamp).getTime(),
          },
        },
        update: {
          configValue: {
            version,
            progress,
            status,
            timestamp: new Date(timestamp).getTime(),
          },
        },
      });

      if (status === 'completed') {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: { firmwareVersion: version },
        });
      }

      this.logger.debug(
        `Processed OTA progress for device ${deviceId}: ${progress}%`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing OTA progress for device ${deviceId}:`,
        error,
      );
    }
  }

  async processDeviceLog(deviceId: string, data: any) {
    try {
      const { level, message, timestamp = new Date() } = data;

      this.logger.log(`Device log [${deviceId}] [${level}]: ${message}`);
    } catch (error) {
      this.logger.error(`Error processing device log for ${deviceId}:`, error);
    }
  }
}
