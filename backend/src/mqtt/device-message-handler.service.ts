import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  IMqttMessageHandler,
  DeviceTelemetryMessage,
  DeviceStatusMessage,
  DeviceAlarmMessage,
  DeviceLogMessage,
  DeviceCommandResponseMessage,
  OtaProgressMessage,
  SleepDataMessage,
  SleepStateMessage,
  SleepReportMessage,
} from './interfaces/mqtt-message.interface';
import { DataProcessorService } from '../data-processor/data-processor.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WebSocketService } from '../websocket/websocket.service';
import { AlarmService } from '../alarm/alarm.service';
import { AliyunIotBridgeService } from './aliyun-iot-bridge.service';

@Injectable()
export class DeviceMessageHandlerService
  implements IMqttMessageHandler, OnModuleInit
{
  private readonly logger = new Logger(DeviceMessageHandlerService.name);
  private readonly PRIORITY = 10;

  constructor(
    @Optional() private dataProcessor: DataProcessorService,
    @Optional() private prisma: PrismaService,
    @Optional() private redisService: RedisService,
    @Optional() private wsService: WebSocketService,
    @Optional() private alarmService: AlarmService,
    @Optional() private aliyunBridge: AliyunIotBridgeService,
  ) {}

  onModuleInit() {
    this.logger.log('Device Message Handler Service initialized');
  }

  getPriority(): number {
    return this.PRIORITY;
  }

  canHandle(topic: string): boolean {
    try {
      const supportedPatterns = [
        'device/+/telemetry',
        'device/+/status',
        'device/+/alarm',
        'device/+/log',
        'device/+/command/response',
        'device/+/ota/progress',
        'sleep/+/data',
        'sleep/+/state',
        'sleep/+/report',
      ];

      return supportedPatterns.some((pattern) =>
        this.topicMatches(topic, pattern),
      );
    } catch (error) {
      this.logger.error('Error in canHandle:', error);
      return false;
    }
  }

  async handle(topic: string, message: any): Promise<void> {
    try {
      const topicParts = topic.split('/');
      const rootTopic = topicParts[0];
      const deviceId = topicParts[1];
      const messageType = topicParts.slice(2).join('/');
      const normalizedMessage = this.normalizeIncomingMessage(
        deviceId,
        message,
      );

      this.logger.debug(
        `Processing message from device ${deviceId} on topic ${topic}`,
      );

      if (rootTopic === 'device') {
        await this.handleDeviceMessage(
          deviceId,
          messageType,
          normalizedMessage,
        );
        return;
      }

      if (rootTopic === 'sleep') {
        await this.handleSleepMessage(deviceId, messageType, normalizedMessage);
        return;
      }

      this.logger.warn(`Unknown message topic pattern: ${topic}`);
    } catch (error) {
      this.logger.error(`Error handling message on topic ${topic}:`, error);
      throw error;
    }
  }

  private async handleDeviceMessage(
    deviceId: string,
    messageType: string,
    message: any,
  ): Promise<void> {
    switch (messageType) {
      case 'telemetry':
        await this.handleTelemetry(deviceId, message);
        break;
      case 'status':
        await this.handleStatus(deviceId, message);
        break;
      case 'alarm':
        await this.handleAlarm(deviceId, message);
        break;
      case 'log':
        await this.handleLog(deviceId, message);
        break;
      case 'command/response':
        await this.handleCommandResponse(deviceId, message);
        break;
      case 'ota/progress':
        await this.handleOtaProgress(deviceId, message);
        break;
      default:
        this.logger.warn(`Unknown device message type: ${messageType}`);
    }
  }

  private async handleSleepMessage(
    deviceId: string,
    messageType: string,
    message: any,
  ): Promise<void> {
    switch (messageType) {
      case 'data':
        await this.handleSleepData(deviceId, message);
        break;
      case 'state':
        await this.handleSleepState(deviceId, message);
        break;
      case 'report':
        await this.handleSleepReport(deviceId, message);
        break;
      default:
        this.logger.warn(`Unknown sleep message type: ${messageType}`);
    }
  }

  private async handleTelemetry(
    deviceId: string,
    message: DeviceTelemetryMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const lightState = this.normalizeLightState(
        payload.light ?? (message as any).light,
      );
      const vitalSigns = this.buildVitalSignsSnapshot(
        deviceId,
        payload,
        message.timestamp,
        lightState,
      );

      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.dataProcessor) {
        await this.dataProcessor.processVitalSigns(deviceId, {
          ...payload,
          timestamp: message.timestamp,
        });
      }

      if (this.redisService) {
        await this.redisService.set(
          `telemetry:${deviceId}`,
          JSON.stringify(vitalSigns),
          60,
        );
        await this.redisService.set(
          `vital_signs:${deviceId}`,
          JSON.stringify(vitalSigns),
          60,
        );

        if (lightState) {
          await this.redisService.set(
            `light_state:${deviceId}`,
            JSON.stringify(lightState),
            300,
          );
        }
      }

      await this.persistLightState(deviceId, lightState);

      if (this.wsService) {
        this.wsService.sendVitalSigns(deviceId, vitalSigns);
        if (lightState) {
          this.wsService.sendLightState(deviceId, lightState);
        }
      }

      if (this.aliyunBridge) {
        await this.aliyunBridge.publishProperties(deviceId, {
          heartRate: vitalSigns.heartRate,
          breathingRate: vitalSigns.breathingRate,
          bodyMovement: vitalSigns.bodyMovement,
          sleepState: vitalSigns.sleepState,
          sleepScore: vitalSigns.sleepScore,
          light: lightState,
        });
      }

      this.logger.debug(`Telemetry data processed for device ${deviceId}`);
    } catch (error) {
      this.logger.error(
        `Error processing telemetry for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleStatus(
    deviceId: string,
    message: DeviceStatusMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const online =
        this.normalizeBoolean(payload.online) ??
        this.normalizeBoolean(payload.status) ??
        true;
      const status =
        this.normalizeStringValue(payload.status) ||
        (online ? 'online' : 'offline');
      const normalizedLastSeen = this.normalizeTimestamp(
        payload.lastSeen ?? payload.last_seen ?? message.timestamp,
      );
      const firmwareVersion =
        this.normalizeStringValue(
          payload.firmwareVersion ?? payload.firmware_version,
        ) || undefined;
      const bindToken =
        this.normalizeStringValue(payload.bindToken ?? payload.bind_token) ||
        undefined;
      const lightState = this.normalizeLightState(
        payload.light ?? (message as any).light,
      );
      const batteryLevel = this.normalizeNumber(
        payload.batteryLevel ?? payload.battery_level ?? payload.battery,
      );
      const signalStrength = this.normalizeNumber(
        payload.signalStrength ?? payload.signal_strength ?? payload.rssi,
      );

      await this.updateDeviceOnlineStatus(deviceId, online, normalizedLastSeen);

      if (this.prisma) {
        await this.prisma.device.upsert({
          where: { id: deviceId },
          create: {
            id: deviceId,
            name: `Sleep Lamp ${deviceId.slice(-6) || deviceId}`,
            type: 'sleep_lamp',
            status: online ? 'online' : 'offline',
            lastSeen: new Date(normalizedLastSeen),
            firmwareVersion,
          },
          update: {
            status: online ? 'online' : 'offline',
            lastSeen: new Date(normalizedLastSeen),
            firmwareVersion,
          },
        });
      }

      if (this.redisService) {
        await this.redisService.set(
          `device_status:${deviceId}`,
          JSON.stringify({
            deviceId,
            device_id: deviceId,
            online,
            status,
            lastSeen: normalizedLastSeen,
            last_seen: normalizedLastSeen,
            firmwareVersion,
            firmware_version: firmwareVersion,
            uptime: this.normalizeNumber(payload.uptime),
            error: payload.error,
            bindToken,
            bind_token: bindToken,
            batteryLevel,
            battery_level: batteryLevel,
            signalStrength,
            signal_strength: signalStrength,
          }),
          300,
        );

        if (bindToken?.startsWith('prov_')) {
          await this.redisService.set(
            `provision_device:${bindToken}`,
            JSON.stringify({ deviceId, onlineAt: Date.now() }),
            600,
          );
        }

        if (lightState) {
          await this.redisService.set(
            `light_state:${deviceId}`,
            JSON.stringify(lightState),
            300,
          );
        }
      }

      await this.persistLightState(deviceId, lightState);

      if (bindToken?.startsWith('prov_')) {
        await this.handleProvisioningTokenSeen(deviceId, bindToken);
      }

      if (this.wsService) {
        this.wsService.sendDeviceStatus(deviceId, online, status, {
          lastSeen: normalizedLastSeen,
          firmwareVersion,
          bindToken,
          batteryLevel,
          signalStrength,
          light: lightState || undefined,
        });
        if (lightState) {
          this.wsService.sendLightState(deviceId, lightState);
        }
      }

      this.logger.debug(
        `Status message processed for device ${deviceId}: ${online ? 'online' : 'offline'}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing status for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleAlarm(
    deviceId: string,
    message: DeviceAlarmMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const alarmType =
        this.normalizeStringValue(payload.alarmType ?? payload.alarm_type) ||
        'unknown_alarm';
      const level = this.normalizeStringValue(payload.level) || 'warning';
      const alarmMessage =
        this.normalizeStringValue(payload.message ?? payload.error_message) ||
        alarmType;
      const value = this.normalizeNumber(payload.value);
      const threshold = this.normalizeNumber(payload.threshold);
      const duration = this.normalizeNumber(payload.duration);

      this.logger.warn(
        `Processing alarm from device ${deviceId}: ${alarmType}`,
      );
      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      let userId: string | undefined;
      if (this.prisma) {
        const device = await this.prisma.device.findFirst({
          where: { id: deviceId },
          select: { tenantId: true },
        });
        if (!device?.tenantId) {
          throw new Error(`Device ${deviceId} has no tenant assignment`);
        }
        const userDevice = await this.prisma.userDevice.findFirst({
          where: { deviceId },
        });
        userId = userDevice?.userId;

        const alarm = await this.prisma.alarmRecord.create({
          data: {
            tenantId: device.tenantId,
            deviceId,
            userId,
            type: alarmType,
            level,
            message: alarmMessage,
            value: value ?? null,
            threshold: threshold ?? null,
            timestamp: new Date(message.timestamp),
            status: 'pending',
          },
        });

        if (userId && this.alarmService) {
          try {
            await this.alarmService.sendAlarmNotifications({
              alarmId: alarm.id,
              deviceId,
              userId,
              type: alarmType,
              level,
              message: alarmMessage,
              value,
              threshold,
              timestamp: message.timestamp,
            });
          } catch (error) {
            this.logger.error('Error sending alarm notifications:', error);
          }
        }
      }

      if (this.wsService) {
        this.wsService.sendAlarm(deviceId, {
          alarmId:
            this.normalizeStringValue(
              payload.alarmId ?? payload.alarm_id ?? message.messageId,
            ) || '',
          deviceId,
          type: alarmType,
          level,
          message: alarmMessage,
          value: value ?? undefined,
          threshold: threshold ?? undefined,
          timestamp: message.timestamp,
          status: 'pending',
        });
      }

      if (duration !== undefined) {
        this.logger.warn(
          `Alarm duration reported for ${deviceId}: ${duration}s`,
        );
      }

      this.logger.warn(`Alarm processed for device ${deviceId}: ${alarmType}`);
    } catch (error) {
      this.logger.error(
        `Error processing alarm for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleLog(
    deviceId: string,
    message: DeviceLogMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const level = this.normalizeStringValue(payload.level) as
        'debug' | 'info' | 'warn' | 'error' | null;
      const logMessage = this.normalizeStringValue(payload.message) || '';
      const module = this.normalizeStringValue(payload.module) || undefined;
      const line = this.normalizeNumber(payload.line);

      switch (level) {
        case 'debug':
          this.logger.debug(
            `Device log [${deviceId}] [${module || 'unknown'}]: ${logMessage}`,
          );
          break;
        case 'warn':
          this.logger.warn(
            `Device log [${deviceId}] [${module || 'unknown'}]: ${logMessage}`,
          );
          break;
        case 'error':
          this.logger.error(
            `Device log [${deviceId}] [${module || 'unknown'}]: ${logMessage}`,
          );
          break;
        default:
          this.logger.log(
            `Device log [${deviceId}] [${module || 'unknown'}]: ${logMessage}`,
          );
          break;
      }

      if (this.wsService) {
        this.wsService.sendDeviceLog(deviceId, {
          level: level || 'info',
          message: logMessage,
          module,
          line,
          timestamp: message.timestamp,
        });
      }
    } catch (error) {
      this.logger.error(`Error processing log for device ${deviceId}:`, error);
      throw error;
    }
  }

  private async handleCommandResponse(
    deviceId: string,
    message: DeviceCommandResponseMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const commandId =
        this.normalizeStringValue(
          payload.commandId ??
            payload.command_id ??
            payload.cmdId ??
            payload.cmd_id ??
            message.messageId,
        ) || '';

      if (!commandId) {
        this.logger.warn(
          `Skipping command response without commandId from ${deviceId}`,
        );
        return;
      }

      const status =
        this.normalizeStringValue(payload.status) ||
        (this.normalizeBoolean(payload.success) === false
          ? 'error'
          : 'success');
      const result = payload.result ?? payload.response ?? null;
      const cmdError =
        payload.error ??
        payload.error_message ??
        (status === 'error' ? payload.message : undefined);

      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.redisService) {
        await this.redisService.set(
          `command_response:${commandId}`,
          JSON.stringify({
            commandId,
            command_id: commandId,
            deviceId,
            device_id: deviceId,
            status,
            result,
            error: cmdError,
            timestamp: message.timestamp,
          }),
          60,
        );
      }

      if (this.prisma) {
        await this.prisma.deviceCommandRecord.updateMany({
          where: { commandId, deviceId },
          data: {
            status:
              status === 'success'
                ? 'success'
                : status === 'timeout'
                  ? 'timeout'
                  : 'failed',
            response: result ?? null,
            errorMessage: cmdError || null,
            respondedAt: new Date(message.timestamp),
          },
        });
      }

      if (this.wsService) {
        this.wsService.sendCommandResponse(deviceId, {
          commandId,
          deviceId,
          status,
          result,
          error: cmdError,
          timestamp: message.timestamp,
        });
      }

      const responseLightState = this.normalizeLightState(
        result?.light_state ??
          result?.light ??
          payload.light_state ??
          payload.light,
      );
      if (responseLightState) {
        if (this.redisService) {
          await this.redisService.set(
            `light_state:${deviceId}`,
            JSON.stringify(responseLightState),
            300,
          );
        }
        await this.persistLightState(deviceId, responseLightState);
        if (this.wsService) {
          this.wsService.sendLightState(deviceId, responseLightState);
        }
      }

      this.logger.debug(
        `Command response processed for device ${deviceId}: ${commandId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing command response for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleOtaProgress(
    deviceId: string,
    message: OtaProgressMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const version = this.normalizeStringValue(payload.version) || '';
      const progress = this.normalizeNumber(payload.progress) ?? 0;
      const status = this.normalizeStringValue(payload.status) || 'downloading';
      const otaError = payload.error;
      const totalSize = this.normalizeNumber(
        payload.totalSize ?? payload.total_size,
      );
      const downloadedSize = this.normalizeNumber(
        payload.downloadedSize ?? payload.downloaded_size,
      );

      this.logger.debug(
        `Processing OTA progress from device ${deviceId}: ${progress}%`,
      );
      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.prisma) {
        await this.prisma.deviceConfig.upsert({
          where: {
            deviceId_configKey: { deviceId, configKey: 'ota_progress' },
          },
          create: {
            deviceId,
            configKey: 'ota_progress',
            configValue: {
              version,
              progress,
              status,
              error: otaError,
              totalSize,
              downloadedSize,
              timestamp: message.timestamp,
            },
          },
          update: {
            configValue: {
              version,
              progress,
              status,
              error: otaError,
              totalSize,
              downloadedSize,
              timestamp: message.timestamp,
            },
          },
        });

        if (status === 'completed') {
          await this.prisma.device.update({
            where: { id: deviceId },
            data: { firmwareVersion: version },
          });
        }
      }

      if (this.wsService) {
        this.wsService.sendOtaProgress(deviceId, {
          version,
          progress,
          status,
          error: otaError,
          totalSize,
          downloadedSize,
          timestamp: message.timestamp,
        });
      }

      this.logger.debug(
        `OTA progress processed for device ${deviceId}: ${progress}%`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing OTA progress for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleSleepData(
    deviceId: string,
    message: SleepDataMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const lightState = this.normalizeLightState(
        payload.light ?? (message as any).light,
      );
      const vitalSigns = this.buildVitalSignsSnapshot(
        deviceId,
        payload,
        message.timestamp,
        lightState,
      );

      this.logger.debug(`Processing sleep data from device ${deviceId}`);
      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.dataProcessor) {
        await this.dataProcessor.processVitalSigns(deviceId, {
          ...payload,
          timestamp: message.timestamp,
        });
      }

      if (this.redisService) {
        await this.redisService.set(
          `sleep_data:${deviceId}`,
          JSON.stringify(vitalSigns),
          60,
        );
        await this.redisService.set(
          `vital_signs:${deviceId}`,
          JSON.stringify(vitalSigns),
          60,
        );

        if (lightState) {
          await this.redisService.set(
            `light_state:${deviceId}`,
            JSON.stringify(lightState),
            300,
          );
        }
      }

      await this.persistLightState(deviceId, lightState);

      if (this.wsService) {
        this.wsService.sendVitalSigns(deviceId, vitalSigns);
        if (lightState) {
          this.wsService.sendLightState(deviceId, lightState);
        }
      }

      this.logger.debug(`Sleep data processed for device ${deviceId}`);
    } catch (error) {
      this.logger.error(
        `Error processing sleep data for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleSleepState(
    deviceId: string,
    message: SleepStateMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const currentVitalSigns =
        (await this.getCachedJson(`vital_signs:${deviceId}`)) || {};
      const vitalSigns = {
        ...currentVitalSigns,
        ...this.buildVitalSignsSnapshot(deviceId, payload, message.timestamp),
        timestamp: message.timestamp,
      };

      this.logger.debug(
        `Processing sleep state from device ${deviceId}: ${payload.state ?? payload.sleepState}`,
      );
      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.dataProcessor) {
        await this.dataProcessor.processSleepState(deviceId, {
          ...payload,
          timestamp: message.timestamp,
        });
      }

      if (this.redisService) {
        await this.redisService.set(
          `sleep_state:${deviceId}`,
          JSON.stringify({
            deviceId,
            device_id: deviceId,
            timestamp: message.timestamp,
            state: vitalSigns.sleepState,
            sleepState: vitalSigns.sleepState,
            sleep_state: vitalSigns.sleepState,
            duration: vitalSigns.duration,
            duration_seconds: vitalSigns.duration,
            confidence: vitalSigns.confidence,
          }),
          60,
        );
        await this.redisService.set(
          `vital_signs:${deviceId}`,
          JSON.stringify(vitalSigns),
          60,
        );
      }

      if (this.wsService) {
        this.wsService.sendVitalSigns(deviceId, vitalSigns);
      }

      this.logger.debug(
        `Sleep state processed for device ${deviceId}: ${vitalSigns.sleepState}`,
      );
    } catch (error) {
      this.logger.error(
        `Error processing sleep state for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async handleSleepReport(
    deviceId: string,
    message: SleepReportMessage,
  ): Promise<void> {
    try {
      const payload = this.extractPayload(message);
      const reportDate =
        this.normalizeStringValue(payload.reportDate ?? payload.report_date) ||
        new Date(message.timestamp).toISOString().slice(0, 10);
      const sleepReport = {
        deviceId,
        reportDate,
        sleepScore:
          this.normalizeNumber(payload.sleepScore ?? payload.sleep_score) ?? 0,
        sleepDuration: this.normalizeSleepDurationPayload(
          payload.sleepDuration ?? payload.sleep_duration,
        ),
        sleepEfficiency:
          this.normalizeNumber(
            payload.sleepEfficiency ?? payload.sleep_efficiency,
          ) ?? 0,
        sleepLatency:
          this.normalizeNumber(payload.sleepLatency ?? payload.sleep_latency) ??
          0,
        awakenings: this.normalizeNumber(payload.awakenings) ?? 0,
        sleepStructure: this.normalizeSleepStructure(
          payload.sleepStructure ?? payload.sleep_structure,
        ),
        vitalSigns: this.normalizeSleepReportVitalSigns(
          payload.vitalSigns ?? payload.vital_signs,
        ),
        healthSuggestions: this.normalizeStringArray(
          payload.healthSuggestions ?? payload.health_suggestions,
        ),
        timestamp: message.timestamp,
      };

      this.logger.debug(`Processing sleep report from device ${deviceId}`);
      await this.updateDeviceOnlineStatus(deviceId, true, message.timestamp);

      if (this.prisma) {
        const device = await this.prisma.device.findFirst({
          where: { id: deviceId },
          select: { tenantId: true },
        });
        if (!device?.tenantId) {
          throw new Error(`Device ${deviceId} has no tenant assignment`);
        }
        const userDevice = await this.prisma.userDevice.findFirst({
          where: { deviceId },
        });

        await this.prisma.sleepReport.upsert({
          where: {
            deviceId_reportDate: {
              deviceId,
              reportDate: new Date(reportDate),
            },
          },
          create: {
            tenantId: device.tenantId,
            deviceId,
            userId: userDevice?.userId,
            reportDate: new Date(reportDate),
            sleepScore: sleepReport.sleepScore,
            sleepDuration: sleepReport.sleepDuration,
            sleepEfficiency: sleepReport.sleepEfficiency,
            sleepLatency: sleepReport.sleepLatency,
            awakenings: sleepReport.awakenings,
            sleepStructure: sleepReport.sleepStructure,
            vitalSigns: sleepReport.vitalSigns,
            healthSuggestions: sleepReport.healthSuggestions,
          },
          update: {
            sleepScore: sleepReport.sleepScore,
            sleepDuration: sleepReport.sleepDuration,
            sleepEfficiency: sleepReport.sleepEfficiency,
            sleepLatency: sleepReport.sleepLatency,
            awakenings: sleepReport.awakenings,
            sleepStructure: sleepReport.sleepStructure,
            vitalSigns: sleepReport.vitalSigns,
            healthSuggestions: sleepReport.healthSuggestions,
          },
        });
      }

      if (this.wsService) {
        this.wsService.sendSleepReport(deviceId, sleepReport);
      }

      this.logger.debug(`Sleep report processed for device ${deviceId}`);
    } catch (error) {
      this.logger.error(
        `Error processing sleep report for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  private async updateDeviceOnlineStatus(
    deviceId: string,
    online: boolean,
    timestamp?: number,
  ): Promise<void> {
    const normalizedTimestamp = this.normalizeTimestamp(timestamp);
    const lastSeen = new Date(normalizedTimestamp);
    const existingStatus =
      (await this.getCachedJson(`device_status:${deviceId}`)) || {};

    if (this.prisma) {
      await this.prisma.device.upsert({
        where: { id: deviceId },
        create: {
          id: deviceId,
          name: `Sleep Lamp ${deviceId.slice(-6) || deviceId}`,
          type: 'sleep_lamp',
          status: online ? 'online' : 'offline',
          lastSeen,
        },
        update: {
          status: online ? 'online' : 'offline',
          lastSeen,
        },
      });
    }

    if (this.redisService) {
      await this.redisService.set(
        `device_online:${deviceId}`,
        online ? '1' : '0',
        300,
      );
      await this.redisService.set(
        `device_status:${deviceId}`,
        JSON.stringify({
          ...existingStatus,
          deviceId,
          device_id: deviceId,
          online,
          status: online ? 'online' : 'offline',
          lastSeen: normalizedTimestamp,
          last_seen: normalizedTimestamp,
        }),
        300,
      );
    }
  }

  private normalizeIncomingMessage(deviceId: string, message: any) {
    const payload = this.extractPayload(message);
    const timestamp = this.normalizeTimestamp(
      message?.timestamp ??
        message?.ts ??
        payload?.timestamp ??
        payload?.ts ??
        payload?.lastSeen ??
        payload?.last_seen,
    );

    return {
      ...(message && typeof message === 'object' ? message : {}),
      deviceId,
      data: payload,
      timestamp,
    };
  }

  private extractPayload(message: any): Record<string, any> {
    if (
      message?.data &&
      typeof message.data === 'object' &&
      !Array.isArray(message.data)
    ) {
      return message.data;
    }

    if (message && typeof message === 'object') {
      const { data, ...rest } = message;
      return rest;
    }

    return {};
  }

  private async persistLightState(
    deviceId: string,
    lightState: any,
  ): Promise<void> {
    if (!lightState || !this.prisma) {
      return;
    }

    await this.prisma.deviceConfig.upsert({
      where: { deviceId_configKey: { deviceId, configKey: 'light_state' } },
      create: {
        deviceId,
        configKey: 'light_state',
        configValue: lightState,
      },
      update: {
        configValue: lightState,
      },
    });
  }

  private buildVitalSignsSnapshot(
    deviceId: string,
    payload: Record<string, any>,
    timestamp: number,
    lightState?: any,
  ) {
    return {
      deviceId,
      device_id: deviceId,
      timestamp,
      heartRate: this.normalizeMetricValue(
        payload.heartRate ?? payload.heart_rate,
      ),
      breathingRate: this.normalizeMetricValue(
        payload.breathingRate ?? payload.breathing_rate,
      ),
      bodyMovement: this.normalizeMetricValue(
        payload.bodyMovement ?? payload.body_movement ?? payload.movement_level,
      ),
      sleepState:
        this.normalizeSleepStateValue(
          payload.sleepState ?? payload.sleep_state ?? payload.state,
        ) || 'unknown',
      sleepScore: this.normalizeMetricValue(
        payload.sleepScore ?? payload.sleep_score,
      ),
      confidence: this.normalizeMetricValue(
        payload.confidence ?? payload.sleep_state?.confidence,
      ),
      duration: this.normalizeMetricValue(
        payload.duration ?? payload.duration_seconds,
      ),
      light: lightState || undefined,
      light_state: lightState || undefined,
    };
  }

  private async getCachedJson(
    key: string,
  ): Promise<Record<string, any> | null> {
    if (!this.redisService) {
      return null;
    }

    const raw = await this.redisService.get(key);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as Record<string, any>;
    } catch (error) {
      this.logger.warn(`Failed to parse cached json for key ${key}`);
      return null;
    }
  }

  private normalizeLightState(raw: any) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const brightness = this.normalizeMetricValue(raw.brightness) ?? 0;
    const colorTemp =
      this.normalizeMetricValue(raw.color_temp ?? raw.colorTemp) ?? 4000;
    const power = this.normalizeBoolean(raw.power ?? raw.on) ?? false;

    return {
      power,
      on: power,
      brightness: Math.max(0, Math.min(100, brightness)),
      colorTemp: Math.max(2700, Math.min(6500, colorTemp)),
      color_temp: Math.max(2700, Math.min(6500, colorTemp)),
      source: this.normalizeStringValue(raw.source) || 'device',
      updatedAt: this.normalizeTimestamp(raw.updatedAt ?? raw.updated_at),
      updated_at: this.normalizeTimestamp(raw.updatedAt ?? raw.updated_at),
    };
  }

  private normalizeSleepDurationPayload(raw: any) {
    const source = raw && typeof raw === 'object' ? raw : {};

    return {
      total: this.normalizeNumber(source.total) ?? 0,
      deep:
        this.normalizeNumber(
          source.deep ?? source.deepSleep ?? source.deep_sleep,
        ) ?? 0,
      light:
        this.normalizeNumber(
          source.light ?? source.lightSleep ?? source.light_sleep,
        ) ?? 0,
      rem:
        this.normalizeNumber(
          source.rem ?? source.remSleep ?? source.rem_sleep,
        ) ?? 0,
      awake: this.normalizeNumber(source.awake) ?? 0,
    };
  }

  private normalizeSleepReportVitalSigns(raw: any) {
    const source = raw && typeof raw === 'object' ? raw : {};

    return {
      avgHeartRate:
        this.normalizeNumber(source.avgHeartRate ?? source.avg_heart_rate) ?? 0,
      minHeartRate:
        this.normalizeNumber(source.minHeartRate ?? source.min_heart_rate) ?? 0,
      maxHeartRate:
        this.normalizeNumber(source.maxHeartRate ?? source.max_heart_rate) ?? 0,
      avgBreathingRate:
        this.normalizeNumber(
          source.avgBreathingRate ?? source.avg_breathing_rate,
        ) ?? 0,
      minBreathingRate:
        this.normalizeNumber(
          source.minBreathingRate ?? source.min_breathing_rate,
        ) ?? 0,
      maxBreathingRate:
        this.normalizeNumber(
          source.maxBreathingRate ?? source.max_breathing_rate,
        ) ?? 0,
    };
  }

  private normalizeSleepStructure(raw: any) {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.map((item) => ({
      state: this.normalizeStringValue(item?.state) || 'unknown',
      startTime: this.normalizeTimestamp(item?.startTime ?? item?.start_time),
      endTime: this.normalizeTimestamp(item?.endTime ?? item?.end_time),
      durationSeconds:
        this.normalizeNumber(
          item?.durationSeconds ?? item?.duration_seconds ?? item?.duration,
        ) ?? 0,
      confidence: this.normalizeNumber(item?.confidence) ?? 0,
    }));
  }

  private normalizeStringArray(value: any): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.normalizeStringValue(item))
      .filter((item): item is string => Boolean(item));
  }

  private normalizeMetricValue(value: any): number | undefined {
    if (value && typeof value === 'object' && 'value' in value) {
      return this.normalizeNumber(value.value);
    }

    return this.normalizeNumber(value);
  }

  private normalizeSleepStateValue(value: any): string | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'object') {
      return this.normalizeStringValue(value.state ?? value.value) ?? undefined;
    }

    return this.normalizeStringValue(value) ?? undefined;
  }

  private normalizeStringValue(value: any): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private normalizeNumber(value: any): number | undefined {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  private normalizeBoolean(value: any): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'on', 'online', 'yes'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'off', 'offline', 'no'].includes(normalized)) {
        return false;
      }
    }

    return undefined;
  }

  private normalizeTimestamp(timestamp: any): number {
    const numericValue = this.normalizeNumber(timestamp);
    const minReasonableEpochMs = 946684800000;

    if (numericValue === undefined) {
      return Date.now();
    }

    if (numericValue >= minReasonableEpochMs) {
      return Math.round(numericValue);
    }

    if (numericValue > 0) {
      return Math.round(numericValue * 1000);
    }

    return Date.now();
  }

  private async handleProvisioningTokenSeen(
    deviceId: string,
    bindToken: string,
  ) {
    if (!this.prisma) {
      return;
    }

    const now = new Date();
    const tokenRecord = await this.prisma.deviceProvisionToken.findUnique({
      where: { token: bindToken },
    });

    if (!tokenRecord) {
      return;
    }

    await this.prisma.deviceProvisionToken.update({
      where: { id: tokenRecord.id },
      data: {
        deviceId,
        status: tokenRecord.status === 'completed' ? 'completed' : 'claimed',
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
        userId: tokenRecord.userId,
        deviceId,
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
    });
  }

  private topicMatches(topic: string, pattern: string): boolean {
    if (pattern === topic) return true;

    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');

    if (
      topicParts.length !== patternParts.length &&
      !patternParts.includes('#')
    ) {
      return false;
    }

    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i] === '#') {
        return true;
      }
      if (patternParts[i] !== '+' && patternParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return topicParts.length === patternParts.length;
  }
}
