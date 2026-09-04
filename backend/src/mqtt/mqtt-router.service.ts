import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  IMqttMessageHandler,
  MqttRouteRule,
  MqttMessageProcessResult,
  MqttMessageType,
} from './interfaces/mqtt-message.interface';

/**
 * MQTT消息路由器服务
 * 负责消息的路由分发和处理器管理
 */
@Injectable()
export class MqttRouterService implements OnModuleInit {
  private readonly logger = new Logger(MqttRouterService.name);

  // 消息处理器注册表
  private handlers: Map<string, IMqttMessageHandler> = new Map();

  // 路由规则
  private routeRules: MqttRouteRule[] = [];

  // 消息统计
  private messageStats = {
    totalReceived: 0,
    totalProcessed: 0,
    totalErrors: 0,
    messagesByType: {} as Record<string, number>,
    messagesByDevice: {} as Record<string, number>,
    processingTimes: [] as number[],
  };

  onModuleInit() {
    this.initializeDefaultRoutes();
    this.logger.log('MQTT Router Service initialized');
  }

  /**
   * 初始化默认路由规则
   */
  private initializeDefaultRoutes() {
    const defaultRoutes: MqttRouteRule[] = [
      // 设备遥测数据路由
      {
        topicPattern: 'device/+/telemetry',
        messageType: MqttMessageType.DEVICE_TELEMETRY,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
      // 设备状态路由
      {
        topicPattern: 'device/+/status',
        messageType: MqttMessageType.DEVICE_STATUS,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
      // 设备报警路由
      {
        topicPattern: 'device/+/alarm',
        messageType: MqttMessageType.DEVICE_ALARM,
        handler: 'DeviceMessageHandler',
        priority: 20, // 高优先级
        enabled: true,
      },
      // 设备日志路由
      {
        topicPattern: 'device/+/log',
        messageType: MqttMessageType.DEVICE_LOG,
        handler: 'DeviceMessageHandler',
        priority: 5,
        enabled: true,
      },
      // 设备命令响应路由
      {
        topicPattern: 'device/+/command/response',
        messageType: MqttMessageType.DEVICE_COMMAND_RESPONSE,
        handler: 'DeviceMessageHandler',
        priority: 15,
        enabled: true,
      },
      // OTA进度路由
      {
        topicPattern: 'device/+/ota/progress',
        messageType: MqttMessageType.DEVICE_OTA_PROGRESS,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
      // 睡眠数据路由
      {
        topicPattern: 'sleep/+/data',
        messageType: MqttMessageType.SLEEP_DATA,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
      // 睡眠状态路由
      {
        topicPattern: 'sleep/+/state',
        messageType: MqttMessageType.SLEEP_STATE,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
      // 睡眠报告路由
      {
        topicPattern: 'sleep/+/report',
        messageType: MqttMessageType.SLEEP_REPORT,
        handler: 'DeviceMessageHandler',
        priority: 10,
        enabled: true,
      },
    ];

    this.routeRules = defaultRoutes;
    this.logger.log(`Initialized ${defaultRoutes.length} default route rules`);
  }

  /**
   * 注册消息处理器
   */
  registerHandler(name: string, handler: IMqttMessageHandler) {
    if (this.handlers.has(name)) {
      this.logger.warn(`Handler ${name} already registered, replacing`);
    }

    this.handlers.set(name, handler);
    this.logger.log(`Registered message handler: ${name}`);
  }

  /**
   * 注销消息处理器
   */
  unregisterHandler(name: string) {
    if (this.handlers.delete(name)) {
      this.logger.log(`Unregistered message handler: ${name}`);
    }
  }

  /**
   * 添加路由规则
   */
  addRouteRule(rule: MqttRouteRule) {
    const existingIndex = this.routeRules.findIndex(
      (r) => r.topicPattern === rule.topicPattern,
    );

    if (existingIndex >= 0) {
      this.routeRules[existingIndex] = rule;
      this.logger.log(`Updated route rule: ${rule.topicPattern}`);
    } else {
      this.routeRules.push(rule);
      this.logger.log(`Added route rule: ${rule.topicPattern}`);
    }

    // 按优先级排序
    this.routeRules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 移除路由规则
   */
  removeRouteRule(topicPattern: string) {
    const index = this.routeRules.findIndex(
      (r) => r.topicPattern === topicPattern,
    );
    if (index >= 0) {
      this.routeRules.splice(index, 1);
      this.logger.log(`Removed route rule: ${topicPattern}`);
    }
  }

  /**
   * 路由消息到对应的处理器
   */
  async routeMessage(
    topic: string,
    message: any,
  ): Promise<MqttMessageProcessResult> {
    const startTime = Date.now();
    const messageId = message.messageId || this.generateMessageId();

    this.messageStats.totalReceived++;

    try {
      // 查找匹配的路由规则
      const matchedRules = this.findMatchingRoutes(topic);

      if (matchedRules.length === 0) {
        this.logger.warn(`No matching route found for topic: ${topic}`);
        return {
          success: false,
          messageId,
          processingTime: Date.now() - startTime,
          error: 'No matching route found',
          handlersExecuted: [],
        };
      }

      const handlersExecuted: string[] = [];

      // 按优先级执行处理器
      for (const rule of matchedRules) {
        if (!rule.enabled) continue;

        const handler = this.handlers.get(rule.handler);
        if (!handler) {
          this.logger.warn(`Handler not found: ${rule.handler}`);
          continue;
        }

        try {
          if (handler.canHandle(topic, message)) {
            await handler.handle(topic, message);
            handlersExecuted.push(rule.handler);

            // 更新统计
            this.updateStats(rule.messageType, message.deviceId, startTime);
          }
        } catch (error) {
          this.logger.error(
            `Error in handler ${rule.handler} for topic ${topic}:`,
            error,
          );
          this.messageStats.totalErrors++;
        }
      }

      this.messageStats.totalProcessed++;

      return {
        success: handlersExecuted.length > 0,
        messageId,
        processingTime: Date.now() - startTime,
        handlersExecuted,
      };
    } catch (error) {
      this.messageStats.totalErrors++;
      this.logger.error(`Error routing message for topic ${topic}:`, error);

      return {
        success: false,
        messageId,
        processingTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        handlersExecuted: [],
      };
    }
  }

  /**
   * 查找匹配的路由规则
   */
  private findMatchingRoutes(topic: string): MqttRouteRule[] {
    return this.routeRules.filter(
      (rule) => rule.enabled && this.topicMatches(topic, rule.topicPattern),
    );
  }

  /**
   * 检查主题是否匹配模式
   */
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

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') {
        return true;
      }
      if (patternParts[i] !== '+' && patternParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return topicParts.length === patternParts.length;
  }

  /**
   * 更新消息统计
   */
  private updateStats(
    messageType: MqttMessageType,
    deviceId: string,
    startTime: number,
  ) {
    // 按类型统计
    this.messageStats.messagesByType[messageType] =
      (this.messageStats.messagesByType[messageType] || 0) + 1;

    // 按设备统计
    if (deviceId) {
      this.messageStats.messagesByDevice[deviceId] =
        (this.messageStats.messagesByDevice[deviceId] || 0) + 1;
    }

    // 处理时间统计
    const processingTime = Date.now() - startTime;
    this.messageStats.processingTimes.push(processingTime);

    // 只保留最近1000条处理时间
    if (this.messageStats.processingTimes.length > 1000) {
      this.messageStats.processingTimes.shift();
    }
  }

  /**
   * 生成消息ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取消息统计信息
   */
  getStats() {
    const avgProcessingTime =
      this.messageStats.processingTimes.length > 0
        ? this.messageStats.processingTimes.reduce((a, b) => a + b, 0) /
          this.messageStats.processingTimes.length
        : 0;

    return {
      totalReceived: this.messageStats.totalReceived,
      totalProcessed: this.messageStats.totalProcessed,
      totalErrors: this.messageStats.totalErrors,
      messagesByType: { ...this.messageStats.messagesByType },
      messagesByDevice: { ...this.messageStats.messagesByDevice },
      averageProcessingTime: avgProcessingTime,
      registeredHandlers: Array.from(this.handlers.keys()),
      routeRules: this.routeRules.length,
    };
  }

  /**
   * 获取所有路由规则
   */
  getRouteRules(): MqttRouteRule[] {
    return [...this.routeRules];
  }

  /**
   * 获取已注册的处理器名称
   */
  getRegisteredHandlers(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.messageStats = {
      totalReceived: 0,
      totalProcessed: 0,
      totalErrors: 0,
      messagesByType: {},
      messagesByDevice: {},
      processingTimes: [],
    };
    this.logger.log('Message statistics reset');
  }
}
