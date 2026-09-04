/**
 * MQTT消息类型定义和接口
 */

// 消息类型枚举
export enum MqttMessageType {
  // 设备消息
  DEVICE_TELEMETRY = 'telemetry',
  DEVICE_STATUS = 'status',
  DEVICE_ALARM = 'alarm',
  DEVICE_LOG = 'log',
  DEVICE_COMMAND = 'command',
  DEVICE_COMMAND_RESPONSE = 'command/response',
  DEVICE_OTA_PROGRESS = 'ota/progress',
  DEVICE_OTA_COMMAND = 'ota/command',

  // 睡眠数据
  SLEEP_DATA = 'data',
  SLEEP_STATE = 'state',
  SLEEP_REPORT = 'report',

  // 云端消息
  CLOUD_CONFIG = 'config',
  CLOUD_COMMAND = 'command',
  CLOUD_NOTIFICATION = 'notification',
}

// 消息优先级
export enum MqttMessagePriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

// 消息QoS级别
export enum MqttQoS {
  AT_MOST_ONCE = 0,
  AT_LEAST_ONCE = 1,
  EXACTLY_ONCE = 2,
}

// 基础MQTT消息接口
export interface BaseMqttMessage {
  messageId?: string;
  timestamp: number;
  deviceId: string;
  type: MqttMessageType;
  priority?: MqttMessagePriority;
}

// 设备遥测数据
export interface DeviceTelemetryMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_TELEMETRY;
  data: {
    heartRate?: number;
    breathingRate?: number;
    bodyMovement?: number;
    sleepState?: string;
    sleepScore?: number;
    confidence?: number;
    temperature?: number;
    humidity?: number;
    battery?: number;
    signalStrength?: number;
    memoryUsage?: number;
    cpuUsage?: number;
  };
}

// 设备状态消息
export interface DeviceStatusMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_STATUS;
  data: {
    online: boolean;
    status: string;
    lastSeen?: number;
    firmwareVersion?: string;
    uptime?: number;
    error?: string;
  };
}

// 设备报警消息
export interface DeviceAlarmMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_ALARM;
  data: {
    alarmType: string;
    level: string;
    message: string;
    value?: number;
    threshold?: number;
    duration?: number;
    acknowledged?: boolean;
  };
}

// 设备日志消息
export interface DeviceLogMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_LOG;
  data: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    module?: string;
    line?: number;
  };
}

// 设备命令消息
export interface DeviceCommandMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_COMMAND;
  data: {
    commandId: string;
    command: string;
    params?: Record<string, any>;
    timeout?: number;
  };
}

// 设备命令响应消息
export interface DeviceCommandResponseMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_COMMAND_RESPONSE;
  data: {
    commandId: string;
    status: 'success' | 'error' | 'timeout';
    result?: any;
    error?: string;
  };
}

// OTA进度消息
export interface OtaProgressMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_OTA_PROGRESS;
  data: {
    version: string;
    progress: number;
    status: 'downloading' | 'installing' | 'completed' | 'failed';
    error?: string;
    totalSize?: number;
    downloadedSize?: number;
  };
}

// OTA命令消息
export interface OtaCommandMessage extends BaseMqttMessage {
  type: MqttMessageType.DEVICE_OTA_COMMAND;
  data: {
    version: string;
    url: string;
    checksum?: string;
    force?: boolean;
  };
}

// 睡眠数据消息
export interface SleepDataMessage extends BaseMqttMessage {
  type: MqttMessageType.SLEEP_DATA;
  data: {
    heartRate?: number;
    breathingRate?: number;
    bodyMovement?: number;
    sleepState?: string;
    sleepScore?: number;
    confidence?: number;
    rawData?: any;
  };
}

// 睡眠状态消息
export interface SleepStateMessage extends BaseMqttMessage {
  type: MqttMessageType.SLEEP_STATE;
  data: {
    state: string;
    duration: number;
    confidence?: number;
  };
}

// 睡眠报告消息
export interface SleepReportMessage extends BaseMqttMessage {
  type: MqttMessageType.SLEEP_REPORT;
  data: {
    reportDate: string;
    sleepScore?: number;
    sleepDuration?: any;
    sleepEfficiency?: number;
    sleepLatency?: number;
    awakenings?: number;
    sleepStructure?: any;
    vitalSigns?: any;
    healthSuggestions?: any[];
  };
}

// 云端配置消息
export interface CloudConfigMessage extends BaseMqttMessage {
  type: MqttMessageType.CLOUD_CONFIG;
  data: {
    configKey: string;
    configValue: any;
    version?: number;
  };
}

// 云端命令消息
export interface CloudCommandMessage extends BaseMqttMessage {
  type: MqttMessageType.CLOUD_COMMAND;
  data: {
    commandId: string;
    command: string;
    params?: Record<string, any>;
  };
}

// 云端通知消息
export interface CloudNotificationMessage extends BaseMqttMessage {
  type: MqttMessageType.CLOUD_NOTIFICATION;
  data: {
    notificationType: string;
    title: string;
    message: string;
    payload?: any;
  };
}

// 联合类型：所有MQTT消息类型
export type MqttMessage =
  | DeviceTelemetryMessage
  | DeviceStatusMessage
  | DeviceAlarmMessage
  | DeviceLogMessage
  | DeviceCommandMessage
  | DeviceCommandResponseMessage
  | OtaProgressMessage
  | OtaCommandMessage
  | SleepDataMessage
  | SleepStateMessage
  | SleepReportMessage
  | CloudConfigMessage
  | CloudCommandMessage
  | CloudNotificationMessage;

// MQTT主题模式
export interface MqttTopicPattern {
  pattern: string;
  description: string;
  messageType: MqttMessageType;
  direction: 'inbound' | 'outbound' | 'bidirectional';
}

// 消息处理器接口
export interface IMqttMessageHandler {
  canHandle(topic: string, message: any): boolean;
  handle(topic: string, message: any): Promise<void>;
  priority?: number;
}

// 消息路由规则
export interface MqttRouteRule {
  topicPattern: string;
  messageType: MqttMessageType;
  handler: string;
  priority: number;
  enabled: boolean;
}

// 消息统计信息
export interface MqttMessageStats {
  totalReceived: number;
  totalSent: number;
  totalErrors: number;
  messagesByType: Record<string, number>;
  messagesByDevice: Record<string, number>;
  averageProcessingTime: number;
  lastMessageTime: number;
}

// 消息处理结果
export interface MqttMessageProcessResult {
  success: boolean;
  messageId: string;
  processingTime: number;
  error?: string;
  handlersExecuted: string[];
}
