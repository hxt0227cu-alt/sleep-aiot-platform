import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import * as mqtt from 'mqtt';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { MqttRouterService } from './mqtt-router.service';
import { DeviceMessageHandlerService } from './device-message-handler.service';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  resolveBackendSubscriptions,
  MQTT_SHARED_GROUP,
} from './mqtt-subscriptions';

/**
 * MQTT服务主类
 * 负责MQTT连接管理、消息收发和子服务协调
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient;
  private readonly logger = new Logger(MqttService.name);

  // 消息回调注册表（用于向后兼容）
  private messageCallbacks: Map<
    string,
    ((topic: string, message: Buffer) => void)[]
  > = new Map();

  // 连接状态
  private connectionState = {
    connected: false,
    reconnectAttempts: 0,
    lastConnectTime: 0,
    lastDisconnectTime: 0,
  } as {
    connected: boolean;
    reconnectAttempts: number;
    lastConnectTime: number;
    lastDisconnectTime: number;
  };

  constructor(
    private configService: ConfigService,
    @Optional() private routerService: MqttRouterService,
    @Optional() private deviceMessageHandler: DeviceMessageHandlerService,
  ) {}

  onModuleInit() {
    this.initializeMqttClient();
    this.registerHandlers();
    this.logger.log('MQTT Service initialized');
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * 初始化MQTT客户端
   */
  private initializeMqttClient() {
    const brokerUrl = this.configService.get<string>('MQTT_BROKER_URL');
    const username = this.configService.get<string>('MQTT_USERNAME');
    const password = this.configService.get<string>('MQTT_PASSWORD');

    if (!brokerUrl) {
      throw new Error('MQTT_BROKER_URL is not defined');
    }

    this.client = mqtt.connect(brokerUrl, {
      username,
      password,
      clientId: this.resolveClientId(),
      clean: true,
      reconnectPeriod: 5000,
      keepalive: 30,
      connectTimeout: 30000,
    });

    this.setupEventHandlers();
    this.logger.log(`MQTT client initialized, connecting to ${brokerUrl}`);
  }

  private resolveClientId(): string {
    const podName = (process.env.HOSTNAME || hostname()).trim();
    const identity = podName || `local-${randomUUID().slice(0, 8)}`;
    return `sleep-backend-${identity}`.slice(0, 128);
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers() {
    this.client.on('connect', () => {
      this.handleConnect();
    });

    this.client.on('error', (error) => {
      this.handleError(error);
    });

    this.client.on('reconnect', () => {
      this.handleReconnect();
    });

    this.client.on('offline', () => {
      this.handleOffline();
    });

    this.client.on('close', () => {
      this.handleClose();
    });

    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message);
    });
  }

  /**
   * 注册消息处理器
   */
  private registerHandlers() {
    if (this.routerService && this.deviceMessageHandler) {
      // 注册设备消息处理器到路由器
      this.routerService.registerHandler(
        'DeviceMessageHandler',
        this.deviceMessageHandler,
      );
      this.logger.log('Device message handler registered to router');
    }
  }

  /**
   * 处理连接事件
   */
  private handleConnect() {
    this.connectionState.connected = true;
    this.connectionState.reconnectAttempts = 0;
    this.connectionState.lastConnectTime = Date.now();

    this.logger.log('Connected to MQTT broker');
    this.subscribeToDefaultTopics();
  }

  /**
   * 处理错误事件
   */
  private handleError(error: Error) {
    this.logger.error('MQTT connection error:', error.message);
    this.connectionState.connected = false;
  }

  /**
   * 处理重连事件
   */
  private handleReconnect() {
    this.connectionState.reconnectAttempts++;
    this.logger.warn(
      `MQTT reconnecting... (attempt ${this.connectionState.reconnectAttempts})`,
    );
  }

  /**
   * 处理离线事件
   */
  private handleOffline() {
    this.connectionState.connected = false;
    this.connectionState.lastDisconnectTime = Date.now();
    this.logger.warn('MQTT client offline');
  }

  /**
   * 处理关闭事件
   */
  private handleClose() {
    this.connectionState.connected = false;
    this.logger.log('MQTT connection closed');
  }

  /**
   * 处理接收到的消息
   */
  private async handleMessage(topic: string, message: Buffer) {
    try {
      const messageStr = message.toString();
      this.logger.debug(
        `Received message on ${topic}: ${messageStr.substring(0, 100)}...`,
      );

      // 调用注册的回调函数（向后兼容）
      const callbacks = this.messageCallbacks.get(topic) || [];
      callbacks.forEach((callback) => callback(topic, message));

      const wildcardCallbacks = this.getWildcardCallbacks(topic);
      wildcardCallbacks.forEach((callback) => callback(topic, message));

      // 通过路由器处理消息
      if (this.routerService) {
        try {
          const messageData = JSON.parse(messageStr);
          const result = await this.routerService.routeMessage(
            topic,
            messageData,
          );

          if (result.success) {
            this.logger.debug(
              `Message routed successfully via handlers: ${result.handlersExecuted.join(', ')}`,
            );
          } else {
            this.logger.warn(
              `Message routing failed: ${result.error || 'No handlers executed'}`,
            );
          }
        } catch (parseError) {
          this.logger.error('Error parsing message JSON:', parseError);
        }
      }
    } catch (error) {
      this.logger.error('Error handling MQTT message:', error);
    }
  }

  /**
   * 订阅默认主题
   *
   * 采用 EMQX 共享订阅（$share/<group>/<topic>）：同一 group 内的多个 backend 副本
   * 只有一个会收到某条消息，从 broker 侧消除了副本间的重复消费（ADR-013）。
   * 注意：`device/+/telemetry` 已由 telemetry-ingest 通过
   * `$share/telemetry-ingest/device/+/telemetry` 独占，backend 必须退订，否则会造成
   * 跨服务重复消费且 backend 无对应落库逻辑。订阅清单见 mqtt-subscriptions.ts。
   */
  private subscribeToDefaultTopics() {
    const subscriptions = resolveBackendSubscriptions();
    const sharedTopics = subscriptions.map((s) => s.shared);

    sharedTopics.forEach((topic) => {
      this.subscribe(topic, { qos: 1 });
    });

    this.logger.log(
      `Subscribed to ${sharedTopics.length} shared topics (group: ${MQTT_SHARED_GROUP})`,
    );
  }

  /**
   * 发布消息
   */
  async publish(
    topic: string,
    message: string | Buffer,
    options?: mqtt.IClientPublishOptions,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('MQTT client not connected'));
        return;
      }

      this.client.publish(topic, message, options, (error) => {
        if (error) {
          this.logger.error(`Failed to publish to ${topic}:`, error);
          reject(error);
        } else {
          this.logger.debug(`Published message to ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * 订阅主题
   */
  subscribe(
    topic: string,
    options?: mqtt.IClientSubscribeOptions,
    callback?: (topic: string, message: Buffer) => void,
  ): void {
    this.client.subscribe(topic, options, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${topic}:`, err);
      } else {
        this.logger.log(`Subscribed to ${topic}`);
      }
    });

    if (callback) {
      if (!this.messageCallbacks.has(topic)) {
        this.messageCallbacks.set(topic, []);
      }
      this.messageCallbacks.get(topic)!.push(callback);
    }
  }

  registerOwnedTopicCallback(
    topic: string,
    callback: (topic: string, message: Buffer) => void,
  ): void {
    if (!resolveBackendSubscriptions().some((entry) => entry.raw === topic)) {
      throw new Error(`MQTT topic is not owned by backend: ${topic}`);
    }
    if (!this.messageCallbacks.has(topic)) {
      this.messageCallbacks.set(topic, []);
    }
    this.messageCallbacks.get(topic)!.push(callback);
  }

  /**
   * 取消订阅主题
   */
  unsubscribe(topic: string): void {
    this.messageCallbacks.delete(topic);
    this.client.unsubscribe(topic, (err) => {
      if (err) {
        this.logger.error(`Failed to unsubscribe from ${topic}:`, err);
      } else {
        this.logger.log(`Unsubscribed from ${topic}`);
      }
    });
  }

  /**
   * 获取通配符回调
   */
  private getWildcardCallbacks(
    topic: string,
  ): ((topic: string, message: Buffer) => void)[] {
    const callbacks: ((topic: string, message: Buffer) => void)[] = [];

    this.messageCallbacks.forEach((topicCallbacks, subscribedTopic) => {
      if (this.topicMatches(topic, subscribedTopic)) {
        callbacks.push(...topicCallbacks);
      }
    });

    return callbacks;
  }

  /**
   * 检查主题是否匹配
   */
  private topicMatches(topic: string, subscribedTopic: string): boolean {
    if (subscribedTopic === topic) return true;

    const topicParts = topic.split('/');
    const subscribedParts = subscribedTopic.split('/');

    if (
      topicParts.length !== subscribedParts.length &&
      !subscribedParts.includes('#')
    ) {
      return false;
    }

    for (let i = 0; i < subscribedParts.length; i++) {
      if (subscribedParts[i] === '#') {
        return true;
      }
      if (subscribedParts[i] !== '+' && subscribedParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return topicParts.length === subscribedParts.length;
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client && this.isConnected()) {
        this.client.end(false, {}, () => {
          this.logger.log('MQTT client disconnected');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 重新连接
   */
  reconnect(): void {
    if (this.client) {
      this.client.reconnect();
      this.logger.log('MQTT reconnect triggered');
    }
  }

  /**
   * 获取MQTT客户端
   */
  getClient(): mqtt.MqttClient {
    return this.client;
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.client?.connected || false;
  }

  /**
   * 获取连接状态
   */
  getConnectionState() {
    return {
      ...this.connectionState,
      connected: this.isConnected(),
    };
  }

  /**
   * 获取服务统计信息
   */
  getServiceStats() {
    return {
      connection: this.getConnectionState(),
      router: this.routerService?.getStats(),
      callbacks: this.messageCallbacks.size,
    };
  }

  // ========== 便捷方法：通过子服务提供的功能 ==========

  /**
   * 发送配置到设备
   */
  /**
   * 发送命令到设备
   */
  /**
   * 发送OTA命令到设备
   */
  /**
   * 获取设备在线状态
   */
  /**
   * 广播消息到所有设备
   */
}
