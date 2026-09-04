import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  MqttMessage,
  MqttMessageType,
  MqttQoS,
  MqttMessagePriority,
  CloudConfigMessage,
  CloudCommandMessage,
  CloudNotificationMessage,
  OtaCommandMessage,
} from './interfaces/mqtt-message.interface';
import { MqttService } from './mqtt.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * 云端消息推送服务
 * 负责向设备推送配置、命令和通知消息
 */
@Injectable()
export class CloudMessagePublisherService {
  private readonly logger = new Logger(CloudMessagePublisherService.name);

  // 消息统计
  private messageStats = {
    totalSent: 0,
    totalFailed: 0,
    totalQueued: 0,
    messagesByType: {} as Record<string, number>,
  };

  constructor(
    @Optional() private mqttService: MqttService,
    @Optional() private prisma: PrismaService,
    @Optional() private redisService: RedisService,
  ) {}

  /**
   * 发布消息到MQTT
   */
  private async publishMessage(
    topic: string,
    message: MqttMessage,
    qos: MqttQoS = MqttQoS.AT_LEAST_ONCE,
  ): Promise<void> {
    if (!this.mqttService) {
      throw new Error('MQTT service not available');
    }

    if (!this.mqttService.isConnected()) {
      throw new Error('MQTT client not connected');
    }

    const messageStr = JSON.stringify(message);
    await this.mqttService.publish(topic, messageStr, { qos });
  }

  /**
   * 更新消息统计
   */
  private updateMessageStats(message: MqttMessage) {
    // 按类型统计
    this.messageStats.messagesByType[message.type] =
      (this.messageStats.messagesByType[message.type] || 0) + 1;

  }

  /**
   * 发送配置消息到设备
   */
  async sendConfigToDevice(
    deviceId: string,
    configKey: string,
    configValue: any,
    options?: {
      qos?: MqttQoS;
      priority?: MqttMessagePriority;
      version?: number;
    },
  ): Promise<void> {
    const message: CloudConfigMessage = {
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
      deviceId,
      type: MqttMessageType.CLOUD_CONFIG,
      priority: options?.priority || MqttMessagePriority.NORMAL,
      data: {
        configKey,
        configValue,
        version: options?.version,
      },
    };

    const topic = `device/${deviceId}/config`;
    await this.enqueueMessage(
      message,
      topic,
      options?.qos || MqttQoS.AT_LEAST_ONCE,
    );

    this.logger.debug(
      `Config message sent to device ${deviceId}: ${configKey}`,
    );
  }

  /**
   * 批量发送配置到设备
   */
  async sendBatchConfigToDevice(
    deviceId: string,
    configs: Array<{ configKey: string; configValue: any; version?: number }>,
    options?: {
      qos?: MqttQoS;
      priority?: MqttMessagePriority;
    },
  ): Promise<void> {
    for (const config of configs) {
      await this.sendConfigToDevice(
        deviceId,
        config.configKey,
        config.configValue,
        {
          ...options,
          version: config.version,
        },
      );
    }

    this.logger.log(
      `Batch config messages sent to device ${deviceId}: ${configs.length} configs`,
    );
  }

  /**
   * 发送命令到设备
   */
  async sendCommandToDevice(
    deviceId: string,
    command: string,
    params?: Record<string, any>,
    options?: {
      qos?: MqttQoS;
      priority?: MqttMessagePriority;
      timeout?: number;
    },
  ): Promise<string> {
    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const message: CloudCommandMessage = {
      messageId: commandId,
      timestamp: Date.now(),
      deviceId,
      type: MqttMessageType.CLOUD_COMMAND,
      priority: options?.priority || MqttMessagePriority.HIGH,
      data: {
        commandId,
        command,
        params,
      },
    };

    const topic = `device/${deviceId}/command`;
    await this.enqueueMessage(
      message,
      topic,
      options?.qos || MqttQoS.AT_LEAST_ONCE,
    );

    // 缓存命令信息
    if (this.redisService) {
      await this.redisService.set(
        `command_info:${commandId}`,
        JSON.stringify({
          commandId,
          deviceId,
          command,
          params,
          timestamp: Date.now(),
          timeout: options?.timeout || 5000,
        }),
        300,
      );
    }

    this.logger.debug(
      `Command message sent to device ${deviceId}: ${command}`,
    );
    return commandId;
  }

  /**
   * 发送通知到设备
   */
  async sendNotificationToDevice(
    deviceId: string,
    notificationType: string,
    title: string,
    message: string,
    payload?: any,
    options?: {
      qos?: MqttQoS;
      priority?: MqttMessagePriority;
    },
  ): Promise<void> {
    const notificationMessage: CloudNotificationMessage = {
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
      deviceId,
      type: MqttMessageType.CLOUD_NOTIFICATION,
      priority: options?.priority || MqttMessagePriority.NORMAL,
      data: {
        notificationType,
        title,
        message,
        payload,
      },
    };

    const topic = `device/${deviceId}/notification`;
    await this.enqueueMessage(
      notificationMessage,
      topic,
      options?.qos || MqttQoS.AT_LEAST_ONCE,
    );

    this.logger.debug(
      `Notification message sent to device ${deviceId}: ${notificationType}`,
    );
  }

  /**
   * 发送OTA命令到设备
   */
  async sendOtaCommandToDevice(
    deviceId: string,
    version: string,
    url: string,
    options?: {
      qos?: MqttQoS;
      priority?: MqttMessagePriority;
      checksum?: string;
      force?: boolean;
    },
  ): Promise<void> {
    const otaMessage: OtaCommandMessage = {
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
      deviceId,
      type: MqttMessageType.DEVICE_OTA_COMMAND,
      priority: options?.priority || MqttMessagePriority.HIGH,
      data: {
        version,
        url,
        checksum: options?.checksum,
        force: options?.force || false,
      },
    };

    const topic = `device/${deviceId}/ota/command`;
    await this.enqueueMessage(
      otaMessage,
      topic,
      options?.qos || MqttQoS.AT_LEAST_ONCE,
    );

    this.logger.debug(
      `OTA command queued for device ${deviceId}: version ${version}`,
    );
  }

  /**
   * 广播消息到所有设备
   */
  async broadcastToAllDevices(
    message: MqttMessage,
    options?: {
      qos?: MqttQoS;
      deviceIds?: string[];
    },
  ): Promise<void> {
    let deviceIds: string[] = [];

    if (options?.deviceIds && options.deviceIds.length > 0) {
      deviceIds = options.deviceIds;
    } else if (this.prisma) {
      // 获取所有在线设备
      const devices = await this.prisma.device.findMany({
        where: { status: 'online' },
        select: { id: true },
      });
      deviceIds = devices.map((d) => d.id);
    }

    for (const deviceId of deviceIds) {
      const deviceMessage = {
        ...message,
        deviceId,
        messageId: this.generateMessageId(),
        timestamp: Date.now(),
      };

      const topic = `device/${deviceId}/command`;
      await this.enqueueMessage(
        deviceMessage,
        topic,
        options?.qos || MqttQoS.AT_LEAST_ONCE,
      );
    }

    this.logger.log(`Broadcast message queued for ${deviceIds.length} devices`);
  }

  /**
   * 将消息加入队列
   */
  private async enqueueMessage(
    message: MqttMessage,
    topic: string,
    qos: MqttQoS = MqttQoS.AT_LEAST_ONCE,
    maxRetries: number = 3,
  ): Promise<void> {
    this.messageStats.totalQueued++;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await this.publishMessage(topic, message, qos);
        this.messageStats.totalSent++;
        this.updateMessageStats(message);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delayMs = Math.min(1000, 100 * 2 ** attempt);
          this.logger.warn(
            `Retrying message to ${topic} (attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    this.messageStats.totalFailed++;
    throw lastError instanceof Error
      ? lastError
      : new Error(`Message to ${topic} failed after ${maxRetries} retries`);
  }

  /**
   * 获取队列状态
   */
  getQueueStatus() {
    return {
      queueSize: 0,
      isProcessing: false,
      stats: {
        ...this.messageStats,
      },
    };
  }

  /**
   * 清空消息队列
   */
  clearQueue() {
    const clearedCount = 0;
    this.logger.log('No in-process message queue is configured');
    return clearedCount;
  }

  /**
   * 获取消息统计
   */
  getStats() {
    return {
      ...this.messageStats,
      queueSize: 0,
      isProcessing: false,
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.messageStats = {
      totalSent: 0,
      totalFailed: 0,
      totalQueued: 0,
      messagesByType: {},
    };
    this.logger.log('Message statistics reset');
  }

  /**
   * 生成消息ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 检查设备是否在线
   */
  private async isDeviceOnline(deviceId: string): Promise<boolean> {
    if (this.redisService) {
      const online = await this.redisService.get(`device_online:${deviceId}`);
      return online === '1';
    }

    if (this.prisma) {
      const device = await this.prisma.device.findUnique({
        where: { id: deviceId },
        select: { status: true },
      });
      return device?.status === 'online';
    }

    return false;
  }

  /**
   * 获取设备配置
   */
  async getDeviceConfig(deviceId: string, configKey: string): Promise<any> {
    if (this.prisma) {
      const config = await this.prisma.deviceConfig.findUnique({
        where: {
          deviceId_configKey: {
            deviceId,
            configKey,
          },
        },
      });
      return config?.configValue;
    }

    return null;
  }

  /**
   * 设置设备配置
   */
  async setDeviceConfig(
    deviceId: string,
    configKey: string,
    configValue: any,
  ): Promise<void> {
    if (this.prisma) {
      await this.prisma.deviceConfig.upsert({
        where: {
          deviceId_configKey: {
            deviceId,
            configKey,
          },
        },
        create: {
          deviceId,
          configKey,
          configValue,
        },
        update: {
          configValue,
        },
      });
    }

    // 发送配置到设备
    await this.sendConfigToDevice(deviceId, configKey, configValue);
  }

  /**
   * 获取所有设备配置
   */
  async getAllDeviceConfigs(deviceId: string): Promise<Record<string, any>> {
    if (this.prisma) {
      const configs = await this.prisma.deviceConfig.findMany({
        where: { deviceId },
      });

      return configs.reduce(
        (acc, config) => {
          acc[config.configKey] = config.configValue;
          return acc;
        },
        {} as Record<string, any>,
      );
    }

    return {};
  }
}
