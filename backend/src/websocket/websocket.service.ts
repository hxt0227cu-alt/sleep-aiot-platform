import { Injectable, Logger } from '@nestjs/common';
import { AppWebSocketGateway } from './websocket.gateway';
import { RealtimeFanoutService } from '../redis/realtime-fanout.service';

export interface DeviceStatusMessage {
  deviceId: string;
  online: boolean;
  status?: string;
  lastSeen?: number;
}

export interface VitalSignsMessage {
  deviceId: string;
  timestamp: number;
  heartRate?: number;
  breathingRate?: number;
  bodyMovement?: number;
  sleepState?: string;
  sleepScore?: number;
  confidence?: number;
  light?: LightStateMessage;
}

export interface LightStateMessage {
  deviceId?: string;
  power: boolean;
  brightness: number;
  colorTemp: number;
  source?: string;
  updatedAt?: number;
}

export interface AlarmMessage {
  alarmId: string;
  deviceId: string;
  type: string;
  level: string;
  message: string;
  value?: number;
  threshold?: number;
  timestamp: number;
  status?: string;
}

export interface CommandResponseMessage {
  commandId: string;
  deviceId: string;
  status: string;
  result?: any;
  error?: any;
  timestamp: number;
}

export interface NotificationMessage {
  userId: string;
  type: string;
  title: string;
  message: string;
  data?: any;
  timestamp: number;
}

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);

  constructor(
    private readonly wsGateway: AppWebSocketGateway,
    private readonly fanout: RealtimeFanoutService,
  ) {}

  sendDeviceStatus(
    deviceId: string,
    online: boolean,
    status?: string,
    details: Record<string, any> = {},
  ) {
    const message = this.buildDeviceStatusPayload(
      deviceId,
      online,
      status,
      details,
    );

    this.fanout.publishToDevice(deviceId, {
      type: 'device_status',
      data: message,
    });

    this.logger.debug(
      `Sent device status for ${deviceId}: ${online ? 'online' : 'offline'}`,
    );
  }

  sendVitalSigns(deviceId: string, vitalSigns: VitalSignsMessage) {
    const payload = this.buildVitalSignsPayload(deviceId, vitalSigns);

    this.fanout.publishToDevice(deviceId, {
      type: 'vital_signs',
      data: payload,
    });

    this.logger.debug(`Sent vital signs for device ${deviceId}`);
  }

  sendLightState(deviceId: string, lightState: LightStateMessage) {
    const payload = this.buildLightStatePayload(deviceId, lightState);

    this.fanout.publishToDevice(deviceId, {
      type: 'light_state',
      data: payload,
    });

    this.logger.debug(`Sent light state for device ${deviceId}`);
  }

  sendAlarm(deviceId: string, alarm: AlarmMessage) {
    this.fanout.publishToDevice(deviceId, {
      type: 'alarm',
      data: alarm,
    });

    this.logger.debug(`Sent alarm for device ${deviceId}: ${alarm.type}`);
  }

  sendCommandResponse(
    deviceId: string,
    commandResponse: CommandResponseMessage,
  ) {
    const payload = this.buildCommandResponsePayload(deviceId, commandResponse);

    this.fanout.publishToDevice(deviceId, {
      type: 'command_response',
      data: payload,
    });

    this.logger.debug(
      `Sent command response for device ${deviceId}: ${commandResponse.commandId}`,
    );
  }

  sendUserNotification(userId: string, notification: NotificationMessage) {
    this.fanout.publishToUser(userId, {
      type: 'notification',
      data: notification,
    });

    this.logger.debug(
      `Sent notification to user ${userId}: ${notification.type}`,
    );
  }

  broadcastSystemMessage(message: any) {
    this.fanout.publishToAll({
      type: 'system',
      data: message,
    });

    this.logger.debug('Broadcasted system message');
  }

  sendOtaProgress(deviceId: string, progress: any) {
    this.fanout.publishToDevice(deviceId, {
      type: 'ota_progress',
      data: {
        deviceId,
        device_id: deviceId,
        ...progress,
        timestamp: this.normalizeTimestamp(progress?.timestamp) ?? Date.now(),
      },
    });

    this.logger.debug(
      `Sent OTA progress for device ${deviceId}: ${progress.progress}%`,
    );
  }

  sendDeviceLog(deviceId: string, log: any) {
    this.fanout.publishToDevice(deviceId, {
      type: 'device_log',
      data: {
        deviceId,
        device_id: deviceId,
        ...log,
        timestamp: this.normalizeTimestamp(log?.timestamp) ?? Date.now(),
      },
    });
  }

  sendSleepReport(deviceId: string, report: any) {
    const payload = this.buildSleepReportPayload(deviceId, report);

    this.fanout.publishToDevice(deviceId, {
      type: 'sleep_report',
      data: payload,
    });

    this.logger.debug(`Sent sleep report for device ${deviceId}`);
  }

  getConnectionStats() {
    return {
      totalClients: this.wsGateway.getConnectedClientsCount(),
      connectedUsers: this.wsGateway.getConnectedUsersCount(),
      connectedDevices: this.wsGateway.getConnectedDevicesCount(),
    };
  }

  isUserConnected(userId: string): boolean {
    return this.wsGateway.isUserConnected(userId);
  }

  isDeviceConnected(deviceId: string): boolean {
    return this.wsGateway.isDeviceConnected(deviceId);
  }

  private buildDeviceStatusPayload(
    deviceId: string,
    online: boolean,
    status?: string,
    details: Record<string, any> = {},
  ) {
    const lastSeen =
      this.normalizeTimestamp(details.lastSeen ?? details.last_seen) ??
      Date.now();
    const lightState = this.buildLightStatePayload(
      deviceId,
      details.light_state ?? details.light,
    );

    return {
      deviceId,
      device_id: deviceId,
      online,
      status: status || details.status || (online ? 'online' : 'offline'),
      lastSeen,
      last_seen: lastSeen,
      firmwareVersion: details.firmwareVersion ?? details.firmware_version,
      firmware_version: details.firmwareVersion ?? details.firmware_version,
      batteryLevel: this.normalizeNumber(
        details.batteryLevel ?? details.battery_level,
      ),
      battery_level: this.normalizeNumber(
        details.batteryLevel ?? details.battery_level,
      ),
      signalStrength: this.normalizeNumber(
        details.signalStrength ?? details.signal_strength,
      ),
      signal_strength: this.normalizeNumber(
        details.signalStrength ?? details.signal_strength,
      ),
      bindToken: details.bindToken ?? details.bind_token,
      bind_token: details.bindToken ?? details.bind_token,
      light: lightState || undefined,
      light_state: lightState || undefined,
    };
  }

  private buildVitalSignsPayload(
    deviceId: string,
    vitalSigns: Record<string, any>,
  ) {
    const timestamp =
      this.normalizeTimestamp(vitalSigns.timestamp ?? vitalSigns.ts) ??
      Date.now();
    const heartRate = this.normalizeMetricValue(
      vitalSigns.heartRate ?? vitalSigns.heart_rate,
    );
    const breathingRate = this.normalizeMetricValue(
      vitalSigns.breathingRate ?? vitalSigns.breathing_rate,
    );
    const bodyMovement = this.normalizeMetricValue(
      vitalSigns.bodyMovement ??
        vitalSigns.body_movement ??
        vitalSigns.movement_level,
    );
    const sleepState =
      this.normalizeSleepStateValue(
        vitalSigns.sleepState ?? vitalSigns.sleep_state,
      ) || 'unknown';
    const sleepScore = this.normalizeNumber(
      vitalSigns.sleepScore ?? vitalSigns.sleep_score,
    );
    const confidence = this.normalizeNumber(
      vitalSigns.confidence ?? vitalSigns.sleep_state?.confidence,
    );
    const duration = this.normalizeNumber(
      vitalSigns.duration ?? vitalSigns.duration_seconds,
    );
    const lightState = this.buildLightStatePayload(
      deviceId,
      vitalSigns.light_state ?? vitalSigns.light,
    );

    return {
      deviceId,
      device_id: deviceId,
      timestamp,
      heartRate,
      heart_rate: {
        value: heartRate ?? 0,
        unit: 'bpm',
        status:
          vitalSigns.heart_rate?.status ||
          this.getVitalMetricStatus(heartRate, 'heart_rate'),
      },
      breathingRate,
      breathing_rate: {
        value: breathingRate ?? 0,
        unit: 'times/min',
        status:
          vitalSigns.breathing_rate?.status ||
          this.getVitalMetricStatus(breathingRate, 'breathing_rate'),
      },
      bodyMovement,
      body_movement: {
        value: bodyMovement ?? 0,
        unit: 'level',
        status:
          vitalSigns.body_movement?.status ||
          this.getMovementStatus(bodyMovement),
      },
      sleepState,
      sleep_state: {
        state: sleepState,
        confidence: confidence ?? 0,
      },
      sleepScore,
      sleep_score: sleepScore,
      confidence,
      duration,
      duration_seconds: duration,
      light: lightState || undefined,
      light_state: lightState || undefined,
    };
  }

  private buildLightStatePayload(deviceId: string, lightState: any) {
    if (!lightState || typeof lightState !== 'object') {
      return null;
    }

    const brightness = this.normalizeNumber(lightState.brightness) ?? 0;
    const colorTemp =
      this.normalizeNumber(lightState.colorTemp ?? lightState.color_temp) ??
      4000;
    const power =
      this.normalizeBoolean(lightState.power ?? lightState.on) ?? false;
    const updatedAt =
      this.normalizeTimestamp(lightState.updatedAt ?? lightState.updated_at) ??
      Date.now();

    return {
      deviceId,
      device_id: deviceId,
      power,
      on: power,
      brightness,
      colorTemp,
      color_temp: colorTemp,
      source:
        typeof lightState.source === 'string' ? lightState.source : 'device',
      updatedAt,
      updated_at: updatedAt,
    };
  }

  private buildCommandResponsePayload(
    deviceId: string,
    commandResponse: CommandResponseMessage,
  ) {
    const timestamp =
      this.normalizeTimestamp(commandResponse.timestamp) ?? Date.now();

    return {
      deviceId,
      device_id: deviceId,
      commandId: commandResponse.commandId,
      command_id: commandResponse.commandId,
      status: commandResponse.status,
      result: commandResponse.result,
      error: commandResponse.error,
      timestamp,
    };
  }

  private buildSleepReportPayload(
    deviceId: string,
    report: Record<string, any>,
  ) {
    const timestamp = this.normalizeTimestamp(report.timestamp) ?? Date.now();
    const reportDate = String(report.reportDate ?? report.report_date ?? '');
    const duration = this.normalizeSleepDuration(
      report.sleepDuration ?? report.sleep_duration,
    );
    const vitalSigns = this.normalizeSleepReportVitalSigns(
      report.vitalSigns ?? report.vital_signs,
    );
    const structure = this.normalizeSleepStructure(
      report.sleepStructure ?? report.sleep_structure,
    );
    const suggestions = this.normalizeStringArray(
      report.healthSuggestions ?? report.health_suggestions,
    );

    return {
      deviceId,
      device_id: deviceId,
      date: report.date ?? reportDate,
      reportDate,
      report_date: reportDate,
      sleepScore:
        this.normalizeNumber(report.sleepScore ?? report.sleep_score) ?? 0,
      sleep_score:
        this.normalizeNumber(report.sleepScore ?? report.sleep_score) ?? 0,
      sleepDuration: {
        total: duration.total,
        deep: duration.deep,
        light: duration.light,
        rem: duration.rem,
        awake: duration.awake,
      },
      sleep_duration: {
        total: duration.total,
        deep_sleep: duration.deep,
        light_sleep: duration.light,
        rem_sleep: duration.rem,
        awake: duration.awake,
      },
      sleepEfficiency:
        this.normalizeNumber(
          report.sleepEfficiency ?? report.sleep_efficiency,
        ) ?? 0,
      sleep_efficiency:
        this.normalizeNumber(
          report.sleepEfficiency ?? report.sleep_efficiency,
        ) ?? 0,
      sleepLatency:
        this.normalizeNumber(report.sleepLatency ?? report.sleep_latency) ?? 0,
      sleep_latency:
        this.normalizeNumber(report.sleepLatency ?? report.sleep_latency) ?? 0,
      awakenings: this.normalizeNumber(report.awakenings) ?? 0,
      sleepStructure: structure.map((item) => ({
        state: item.state,
        startTime: item.startTime,
        endTime: item.endTime,
        durationSeconds: item.durationSeconds,
        confidence: item.confidence,
      })),
      sleep_structure: structure.map((item) => ({
        state: item.state,
        start_time: item.startTime,
        end_time: item.endTime,
        duration: item.durationSeconds,
        duration_seconds: item.durationSeconds,
        confidence: item.confidence,
      })),
      vitalSigns: {
        avgHeartRate: vitalSigns.avgHeartRate,
        minHeartRate: vitalSigns.minHeartRate,
        maxHeartRate: vitalSigns.maxHeartRate,
        avgBreathingRate: vitalSigns.avgBreathingRate,
        minBreathingRate: vitalSigns.minBreathingRate,
        maxBreathingRate: vitalSigns.maxBreathingRate,
      },
      vital_signs: {
        avg_heart_rate: vitalSigns.avgHeartRate,
        min_heart_rate: vitalSigns.minHeartRate,
        max_heart_rate: vitalSigns.maxHeartRate,
        avg_breathing_rate: vitalSigns.avgBreathingRate,
        min_breathing_rate: vitalSigns.minBreathingRate,
        max_breathing_rate: vitalSigns.maxBreathingRate,
      },
      healthSuggestions: suggestions,
      health_suggestions: suggestions,
      timestamp,
    };
  }

  private normalizeSleepDuration(duration: any) {
    const source = duration && typeof duration === 'object' ? duration : {};

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

  private normalizeSleepReportVitalSigns(vitalSigns: any) {
    const source =
      vitalSigns && typeof vitalSigns === 'object' ? vitalSigns : {};

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

  private normalizeSleepStructure(structure: any) {
    if (!Array.isArray(structure)) {
      return [];
    }

    return structure.map((item) => ({
      state: String(item?.state ?? 'unknown'),
      startTime:
        this.normalizeTimestamp(item?.startTime ?? item?.start_time) ??
        Date.now(),
      endTime:
        this.normalizeTimestamp(item?.endTime ?? item?.end_time) ?? Date.now(),
      durationSeconds:
        this.normalizeNumber(
          item?.durationSeconds ?? item?.duration_seconds ?? item?.duration,
        ) ?? 0,
      confidence: this.normalizeNumber(item?.confidence) ?? 0,
    }));
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
      const stateValue = value.state ?? value.value;
      return typeof stateValue === 'string' ? stateValue : undefined;
    }

    return typeof value === 'string' ? value : undefined;
  }

  private normalizeStringArray(value: any): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter(Boolean);
  }

  private normalizeNumber(value: any): number | undefined {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  private normalizeTimestamp(value: any): number | undefined {
    const timestamp = this.normalizeNumber(value);
    if (!timestamp) {
      return undefined;
    }

    return timestamp > 946684800000 ? timestamp : timestamp * 1000;
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

  private getVitalMetricStatus(
    value: number | undefined,
    type: 'heart_rate' | 'breathing_rate',
  ): string {
    if (value === undefined || value <= 0) {
      return 'unknown';
    }

    if (type === 'heart_rate') {
      if (value < 50) return 'low';
      if (value > 120) return 'high';
      return 'normal';
    }

    if (value < 10) return 'low';
    if (value > 25) return 'high';
    return 'normal';
  }

  private getMovementStatus(value: number | undefined): string {
    if (value === undefined) {
      return 'unknown';
    }

    if (value < 0.1) return 'low';
    if (value < 0.5) return 'normal';
    return 'high';
  }
}
