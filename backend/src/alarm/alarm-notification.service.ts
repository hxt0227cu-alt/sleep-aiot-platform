import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { WebSocketService } from '../websocket/websocket.service';

export interface AlarmNotification {
  alarmId: string;
  deviceId: string;
  userId: string;
  type: string;
  level: string;
  message: string;
  value?: number;
  threshold?: number;
  timestamp: number;
}

export interface NotificationChannel {
  type: 'wechat' | 'sms' | 'phone';
  enabled: boolean;
  priority: number;
}

export interface NotificationResult {
  channel: string;
  success: boolean;
  error?: string;
  retryCount: number;
  timestamp: Date;
}

export interface NotificationRetryConfig {
  maxRetries: number;
  retryDelay: number;
  backoffMultiplier: number;
  timeout: number;
}

@Injectable()
export class AlarmNotificationService {
  private readonly logger = new Logger(AlarmNotificationService.name);
  private readonly wechatAppId: string;
  private readonly wechatAppSecret: string;
  private readonly smsAccessKeyId: string;
  private readonly smsAccessKeySecret: string;
  private readonly phoneAccessKeyId: string;
  private readonly phoneAccessKeySecret: string;

  // 重试配置
  private readonly retryConfig: NotificationRetryConfig = {
    maxRetries: 3,
    retryDelay: 1000, // 1秒
    backoffMultiplier: 2,
    timeout: 30000, // 30秒
  };

  // 通知历史和失败统计
  private readonly notificationHistory = new Map<
    string,
    NotificationResult[]
  >();
  private readonly failureStats = new Map<
    string,
    { number: number; lastFailure: Date }
  >();
  private readonly MAX_HISTORY_SIZE = 100;
  private readonly FAILURE_THRESHOLD = 5; // 连续失败5次后降级
  private readonly FAILURE_RESET_TIME = 3600000; // 1小时后重置失败计数

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private wsService: WebSocketService,
  ) {
    this.wechatAppId = this.configService.get<string>('WECHAT_APP_ID') || '';
    this.wechatAppSecret =
      this.configService.get<string>('WECHAT_APP_SECRET') || '';
    this.smsAccessKeyId =
      this.configService.get<string>('SMS_ACCESS_KEY_ID') || '';
    this.smsAccessKeySecret =
      this.configService.get<string>('SMS_ACCESS_KEY_SECRET') || '';
    this.phoneAccessKeyId =
      this.configService.get<string>('PHONE_ACCESS_KEY_ID') || '';
    this.phoneAccessKeySecret =
      this.configService.get<string>('PHONE_ACCESS_KEY_SECRET') || '';
  }

  /**
   * 发送报警通知（带重试和降级）
   */
  async sendAlarmNotification(
    notification: AlarmNotification,
  ): Promise<NotificationResult[]> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: notification.userId },
        include: { emergencyContacts: true },
      });

      if (!user) {
        this.logger.warn(
          `User not found for alarm notification: ${notification.userId}`,
        );
        return [];
      }

      const alarmConfig = await this.prisma.alarmConfig.findFirst({
        where: {
          deviceId: notification.deviceId,
          type: notification.type,
        },
      });

      const channels = this.getNotificationChannels(
        (alarmConfig?.actions as string[]) || [],
      );

      // 按优先级排序通道
      const sortedChannels = this.sortChannelsByPriority(channels);

      const results: NotificationResult[] = [];

      for (const channel of sortedChannels) {
        // 检查通道是否需要降级
        if (this.shouldDegradeChannel(channel.type)) {
          this.logger.warn(`Channel ${channel.type} is degraded, skipping`);
          results.push({
            channel: channel.type,
            success: false,
            error: 'Channel degraded due to repeated failures',
            retryCount: 0,
            timestamp: new Date(),
          });
          continue;
        }

        try {
          const result = await this.sendNotificationWithRetry(
            channel,
            notification,
            user,
          );
          results.push(result);

          // 记录成功
          if (result.success) {
            this.recordSuccess(channel.type);
          } else {
            this.recordFailure(channel.type);
          }
        } catch (error) {
          this.logger.error(
            `Error sending ${channel.type} notification:`,
            error,
          );
          results.push({
            channel: channel.type,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            retryCount: this.retryConfig.maxRetries,
            timestamp: new Date(),
          });
          this.recordFailure(channel.type);
        }
      }

      // 记录通知历史
      this.addToHistory(notification.alarmId, results);

      this.logger.log(
        `Alarm notification sent for alarm ${notification.alarmId}`,
      );
      return results;
    } catch (error) {
      this.logger.error(`Error sending alarm notification:`, error);
      return [];
    }
  }

  /**
   * 带重试机制的通知发送
   */
  private async sendNotificationWithRetry(
    channel: NotificationChannel,
    notification: AlarmNotification,
    user: any,
  ): Promise<NotificationResult> {
    let lastError: Error | null = null;
    let retryCount = 0;

    for (let i = 0; i <= this.retryConfig.maxRetries; i++) {
      try {
        switch (channel.type) {
          case 'wechat':
            await this.sendWechatNotification(notification, user);
            break;
          case 'sms':
            await this.sendSmsNotification(notification, user);
            break;
          case 'phone':
            await this.sendPhoneNotification(notification, user);
            break;
          default:
            throw new Error(`Unknown channel type: ${channel.type}`);
        }

        return {
          channel: channel.type,
          success: true,
          retryCount: i,
          timestamp: new Date(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        retryCount = i;

        if (i < this.retryConfig.maxRetries) {
          // 计算退避延迟
          const delay = this.calculateRetryDelay(i);
          this.logger.warn(
            `Retry ${i + 1}/${this.retryConfig.maxRetries} for ${channel.type} after ${delay}ms`,
          );
          await this.sleep(delay);
        }
      }
    }

    return {
      channel: channel.type,
      success: false,
      error: lastError?.message || 'Unknown error',
      retryCount,
      timestamp: new Date(),
    };
  }

  /**
   * 计算重试延迟（指数退避）
   */
  private calculateRetryDelay(retryCount: number): number {
    return (
      this.retryConfig.retryDelay *
      Math.pow(this.retryConfig.backoffMultiplier, retryCount)
    );
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 检查通道是否需要降级
   */
  private shouldDegradeChannel(channelType: string): boolean {
    const stats = this.failureStats.get(channelType);

    if (!stats) {
      return false;
    }

    // 检查是否超过失败阈值
    if (stats.number >= this.FAILURE_THRESHOLD) {
      // 检查是否需要重置
      const timeSinceLastFailure = Date.now() - stats.lastFailure.getTime();
      if (timeSinceLastFailure > this.FAILURE_RESET_TIME) {
        this.failureStats.delete(channelType);
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * 记录成功
   */
  private recordSuccess(channelType: string): void {
    this.failureStats.delete(channelType);
  }

  /**
   * 记录失败
   */
  private recordFailure(channelType: string): void {
    const stats = this.failureStats.get(channelType) || {
      number: 0,
      lastFailure: new Date(),
    };
    stats.number++;
    stats.lastFailure = new Date();
    this.failureStats.set(channelType, stats);
  }

  /**
   * 按优先级排序通道
   */
  private sortChannelsByPriority(channels: {
    wechat: NotificationChannel;
    sms: NotificationChannel;
    phone: NotificationChannel;
  }): NotificationChannel[] {
    const allChannels = [channels.wechat, channels.sms, channels.phone];
    return allChannels
      .filter((channel) => channel.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * 获取通知通道配置
   */
  private getNotificationChannels(actions: string[]): {
    wechat: NotificationChannel;
    sms: NotificationChannel;
    phone: NotificationChannel;
  } {
    return {
      wechat: {
        type: 'wechat',
        enabled: actions.includes('wechat'),
        priority: 1,
      },
      sms: {
        type: 'sms',
        enabled: actions.includes('sms'),
        priority: 2,
      },
      phone: {
        type: 'phone',
        enabled: actions.includes('phone'),
        priority: 3,
      },
    };
  }

  /**
   * 发送微信通知
   */
  private async sendWechatNotification(
    notification: AlarmNotification,
    user: any,
  ): Promise<void> {
    try {
      if (!user.wechatOpenid) {
        this.logger.warn(`User ${user.id} has no WeChat OpenID`);
        return;
      }

      const accessToken = await this.getWechatAccessToken();
      if (!accessToken) {
        throw new Error('Failed to get WeChat access token');
      }

      const message = {
        touser: user.wechatOpenid,
        msgtype: 'text',
        text: {
          content: this.formatAlarmMessage(notification),
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.retryConfig.timeout,
      );

      try {
        const response = await fetch(
          `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        const result = await response.json();

        if (result.errcode !== 0) {
          throw new Error(`WeChat API error: ${result.errmsg}`);
        }

        this.logger.debug(`WeChat notification sent to user ${user.id}`);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error sending WeChat notification:`, error);
      throw error;
    }
  }

  /**
   * 发送短信通知
   */
  private async sendSmsNotification(
    notification: AlarmNotification,
    user: any,
  ): Promise<void> {
    try {
      if (!user.phone) {
        this.logger.warn(`User ${user.id} has no phone number`);
        return;
      }

      const message = this.formatAlarmMessage(notification);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.retryConfig.timeout,
      );

      try {
        const response = await fetch('https://dysmsapi.aliyuncs.com/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            AccessKeyId: this.smsAccessKeyId,
            Action: 'SendSms',
            Format: 'JSON',
            PhoneNumbers: user.phone,
            SignName: '智能睡眠监测',
            TemplateCode: 'SMS_ALARM_NOTIFICATION',
            TemplateParam: JSON.stringify({
              message,
              level: notification.level,
              timestamp: new Date(notification.timestamp).toLocaleString(
                'zh-CN',
              ),
            }),
            Version: '2017-05-25',
          }).toString(),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const result = await response.json();

        if (result.Code !== 'OK') {
          throw new Error(`SMS API error: ${result.Message}`);
        }

        this.logger.debug(`SMS notification sent to user ${user.id}`);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error sending SMS notification:`, error);
      throw error;
    }
  }

  /**
   * 发送电话通知
   */
  private async sendPhoneNotification(
    notification: AlarmNotification,
    user: any,
  ): Promise<void> {
    try {
      if (!user.phone) {
        this.logger.warn(`User ${user.id} has no phone number`);
        return;
      }

      if (notification.level !== 'critical') {
        this.logger.debug(`Phone notification skipped for non-critical alarm`);
        return;
      }

      const message = this.formatAlarmMessage(notification);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.retryConfig.timeout,
      );

      try {
        const response = await fetch('https://dyvmsapi.aliyuncs.com/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            AccessKeyId: this.phoneAccessKeyId,
            Action: 'SingleCallByTts',
            Format: 'JSON',
            CalledNumber: user.phone,
            TtsCode: 'TTS_ALARM_CRITICAL',
            TtsParam: JSON.stringify({
              message,
              timestamp: new Date(notification.timestamp).toLocaleString(
                'zh-CN',
              ),
            }),
            Version: '2017-05-25',
          }).toString(),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const result = await response.json();

        if (result.Code !== 'OK') {
          throw new Error(`Phone API error: ${result.Message}`);
        }

        this.logger.debug(`Phone notification sent to user ${user.id}`);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error sending phone notification:`, error);
      throw error;
    }
  }

  /**
   * 发送紧急联系人通知
   */
  async sendEmergencyContactNotification(
    notification: AlarmNotification,
    contact: any,
  ): Promise<void> {
    try {
      if (notification.level !== 'critical') {
        return;
      }

      const message = this.formatEmergencyContactMessage(notification, contact);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.retryConfig.timeout,
      );

      try {
        const response = await fetch('https://dysmsapi.aliyuncs.com/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            AccessKeyId: this.smsAccessKeyId,
            Action: 'SendSms',
            Format: 'JSON',
            PhoneNumbers: contact.phone,
            SignName: '智能睡眠监测',
            TemplateCode: 'SMS_EMERGENCY_CONTACT',
            TemplateParam: JSON.stringify({
              message,
              contactName: contact.name,
              timestamp: new Date(notification.timestamp).toLocaleString(
                'zh-CN',
              ),
            }),
            Version: '2017-05-25',
          }).toString(),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const result = await response.json();

        if (result.Code !== 'OK') {
          throw new Error(`SMS API error: ${result.Message}`);
        }

        this.logger.debug(
          `Emergency contact notification sent to ${contact.name}`,
        );
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error sending emergency contact notification:`, error);
      throw error;
    }
  }

  /**
   * 获取微信访问令牌
   */
  private async getWechatAccessToken(): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.wechatAppId}&secret=${this.wechatAppSecret}`,
      );

      const result = await response.json();

      if (result.errcode) {
        throw new Error(`WeChat API error: ${result.errmsg}`);
      }

      return result.access_token;
    } catch (error) {
      this.logger.error(`Error getting WeChat access token:`, error);
      return null;
    }
  }

  /**
   * 格式化报警消息
   */
  private formatAlarmMessage(notification: AlarmNotification): string {
    const levelText =
      {
        critical: '严重',
        warning: '警告',
        info: '提示',
      }[notification.level] || '未知';

    const typeText =
      {
        heart_rate_high: '心率过高',
        heart_rate_low: '心率过低',
        breathing_rate_high: '呼吸频率过高',
        breathing_rate_low: '呼吸频率过低',
        no_movement: '长时间无体动',
      }[notification.type] || '异常检测';

    let message = `[${levelText}] ${typeText}`;

    if (
      notification.value !== undefined &&
      notification.threshold !== undefined
    ) {
      message += `，当前值: ${notification.value}，阈值: ${notification.threshold}`;
    }

    message += `，时间: ${new Date(notification.timestamp).toLocaleString('zh-CN')}`;

    return message;
  }

  /**
   * 格式化紧急联系人消息
   */
  private formatEmergencyContactMessage(
    notification: AlarmNotification,
    contact: any,
  ): string {
    const message = `紧急通知：您的联系人${contact.name}的睡眠监测设备检测到严重异常。${this.formatAlarmMessage(notification)}`;
    return message;
  }

  /**
   * 添加到通知历史
   */
  private addToHistory(alarmId: string, results: NotificationResult[]): void {
    const history = this.notificationHistory.get(alarmId) || [];
    history.push(...results);

    // 限制历史记录大小
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.splice(0, history.length - this.MAX_HISTORY_SIZE);
    }

    this.notificationHistory.set(alarmId, history);
  }

  /**
   * 获取通知历史
   */
  getNotificationHistory(alarmId: string): NotificationResult[] {
    return this.notificationHistory.get(alarmId) || [];
  }

  /**
   * 获取失败统计
   */
  getFailureStats(): Record<string, { number: number; lastFailure: Date }> {
    const stats: Record<string, { number: number; lastFailure: Date }> = {};
    for (const [channel, data] of this.failureStats.entries()) {
      stats[channel] = data;
    }
    return stats;
  }

  /**
   * 重置失败统计
   */
  resetFailureStats(channelType?: string): void {
    if (channelType) {
      this.failureStats.delete(channelType);
    } else {
      this.failureStats.clear();
    }
  }

  /**
   * 清除通知历史
   */
  clearHistory(alarmId?: string): void {
    if (alarmId) {
      this.notificationHistory.delete(alarmId);
    } else {
      this.notificationHistory.clear();
    }
  }
}
