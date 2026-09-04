import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AlarmConfigDto, AlarmRuleDto } from './dto/alarm-config.dto';
import { AlarmQueryDto as AlarmQueryDtoType } from './dto/alarm-query.dto';
import { HandleAlarmDto } from './dto/handle-alarm.dto';
import {
  AlarmNotificationService,
  AlarmNotification,
} from './alarm-notification.service';
import {
  AlarmRuleEngineService,
  VitalSignsData,
  AlarmTriggerResult,
} from './alarm-rule-engine.service';
import {
  AlarmStateService,
  AlarmStatistics,
  AlarmTrend,
  AlarmSummary,
} from './alarm-state.service';
import {
  EmergencyContactService,
  NotificationResult,
} from './emergency-contact.service';

@Injectable()
export class AlarmService {
  private readonly logger = new Logger(AlarmService.name);

  constructor(
    private prisma: PrismaService,
    private notificationService: AlarmNotificationService,
    private ruleEngineService: AlarmRuleEngineService,
    private stateService: AlarmStateService,
    private emergencyContactService: EmergencyContactService,
  ) {}

  /**
   * 获取报警列表
   */
  async getAlarms(userId: string, queryDto: AlarmQueryDtoType) {
    const {
      deviceId,
      startTime,
      endTime,
      level,
      page = 1,
      pageSize = 20,
    } = queryDto;

    const where: any = { userId };

    if (deviceId) {
      where.deviceId = deviceId;
    }

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) {
        where.timestamp.gte = new Date(startTime);
      }
      if (endTime) {
        where.timestamp.lte = new Date(endTime);
      }
    }

    if (level) {
      where.level = level;
    }

    const [alarms, total] = await Promise.all([
      this.prisma.alarmRecord.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.alarmRecord.count({ where }),
    ]);

    return {
      total,
      page,
      pageSize,
      alarms: alarms.map((alarm) => ({
        alarmId: alarm.id,
        deviceId: alarm.deviceId,
        type: alarm.type,
        level: alarm.level,
        message: alarm.message,
        value: alarm.value ? Number(alarm.value) : undefined,
        threshold: alarm.threshold ? Number(alarm.threshold) : undefined,
        timestamp: alarm.timestamp.getTime(),
        status: alarm.status,
        handledBy: alarm.handledBy,
        handledAt: alarm.handledAt?.getTime(),
      })),
    };
  }

  /**
   * 获取报警详情
   */
  async getAlarmById(alarmId: string, userId: string) {
    const alarm = await this.stateService.getAlarmById(alarmId);

    if (!alarm) {
      throw new NotFoundException('报警不存在');
    }

    // 验证权限
    if (alarm.userId !== userId) {
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId: alarm.deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('无权限访问');
      }
    }

    return {
      alarmId: alarm.alarmId,
      deviceId: alarm.deviceId,
      type: alarm.type,
      level: alarm.level,
      message: alarm.message,
      value: alarm.value,
      threshold: alarm.threshold,
      timestamp: alarm.timestamp.getTime(),
      status: alarm.status,
      handledBy: alarm.handledBy,
      handledAt: alarm.handledAt?.getTime(),
      note: alarm.note,
    };
  }

  /**
   * 配置报警规则
   */
  async configureAlarm(userId: string, configDto: AlarmConfigDto) {
    const { deviceId, rules } = configDto;

    // 验证权限
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权限访问');
    }

    const configs = await Promise.all(
      rules.map((rule) =>
        this.prisma.alarmConfig.upsert({
          where: { deviceId_type: { deviceId, type: rule.type } },
          create: {
            deviceId,
            type: rule.type,
            enabled: rule.enabled,
            threshold: rule.threshold,
            duration: rule.duration || 60,
            actions: rule.actions,
          },
          update: {
            enabled: rule.enabled,
            threshold: rule.threshold,
            duration: rule.duration || 60,
            actions: rule.actions,
          },
        }),
      ),
    );

    // 清除规则引擎的冷却期和历史数据
    this.ruleEngineService.clearCooldown(deviceId);
    this.ruleEngineService.clearHistoryData(deviceId);

    return { message: '报警配置成功', configs };
  }

  /**
   * 获取报警配置
   */
  async getAlarmConfig(deviceId: string, userId: string) {
    // 验证权限
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权限访问');
    }

    const configs = await this.prisma.alarmConfig.findMany({
      where: { deviceId },
    });

    return {
      deviceId,
      rules: configs.map((config) => ({
        type: config.type,
        enabled: config.enabled,
        threshold: Number(config.threshold),
        duration: config.duration,
        actions: config.actions as string[],
      })),
    };
  }

  /**
   * 处理报警
   */
  async handleAlarm(
    alarmId: string,
    userId: string,
    handleDto: HandleAlarmDto,
  ) {
    const alarm = await this.stateService.getAlarmById(alarmId);

    if (!alarm) {
      throw new NotFoundException('报警不存在');
    }

    // 验证权限
    if (alarm.userId !== userId) {
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId: alarm.deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('无权限访问');
      }
    }

    const updatedAlarm = await this.stateService.updateAlarmStatus(
      alarmId,
      'handled',
      userId,
      handleDto.note,
    );

    return { message: '报警已标记为已处理', alarm: updatedAlarm };
  }

  /**
   * 检查报警规则（主要入口点）
   */
  async checkAlarmRules(
    deviceId: string,
    vitalSigns: VitalSignsData,
  ): Promise<any[]> {
    try {
      // 获取设备信息
      const device = await this.prisma.device.findUnique({
        where: { id: deviceId },
        include: { userDevices: true },
      });

      if (!device) {
        this.logger.warn(`Device not found: ${deviceId}`);
        return [];
      }

      const userDevice = device.userDevices[0];
      const userId = userDevice?.userId;

      // 构建评估上下文
      const context = {
        deviceId,
        vitalSigns,
        timestamp: new Date(),
      };

      // 评估报警规则
      const triggerResults =
        await this.ruleEngineService.evaluateDeviceRules(context);

      // 处理触发的报警
      const processedAlarms: any[] = [];

      for (const result of triggerResults) {
        try {
          // 创建报警记录
          const alarm = await this.stateService.createAlarm({
            deviceId,
            userId,
            type: result.rule.type,
            level: result.level,
            message: result.message,
            value: result.value,
            threshold: result.threshold,
            timestamp: new Date(),
          });

          // 发送通知
          if (userId) {
            await this.sendAlarmNotifications(alarm, result);
          }

          processedAlarms.push(alarm);
        } catch (error) {
          this.logger.error(`Error processing alarm trigger:`, error);
        }
      }

      return processedAlarms;
    } catch (error) {
      this.logger.error(
        `Error checking alarm rules for device ${deviceId}:`,
        error,
      );
      return [];
    }
  }

  /**
   * 发送报警通知
   */
  async sendAlarmNotifications(
    alarm: any,
    triggerResult?: AlarmTriggerResult,
  ): Promise<void> {
    try {
      const notification: AlarmNotification = {
        alarmId: alarm.alarmId || alarm.id,
        deviceId: alarm.deviceId,
        userId: alarm.userId || '',
        type: alarm.type,
        level: alarm.level,
        message: alarm.message,
        value: alarm.value,
        threshold: alarm.threshold,
        timestamp:
          alarm.timestamp instanceof Date
            ? alarm.timestamp.getTime()
            : alarm.timestamp,
      };

      // 发送用户通知
      await this.notificationService.sendAlarmNotification(notification);

      // 如果是严重报警，通知紧急联系人
      if (alarm.level === 'critical' && alarm.userId) {
        await this.emergencyContactService.notifyEmergencyContacts(
          alarm.userId,
          notification,
          {
            maxContacts: 3,
            onlyCritical: true,
          },
        );
      }

      this.logger.debug(
        `Alarm notifications sent for alarm ${alarm.alarmId || alarm.id}`,
      );
    } catch (error) {
      this.logger.error(`Error sending alarm notifications:`, error);
    }
  }

  /**
   * 获取报警统计信息
   */
  async getAlarmStatistics(
    userId: string,
    deviceId?: string,
    startTime?: Date,
    endTime?: Date,
  ): Promise<AlarmStatistics> {
    if (deviceId) {
      // 验证权限
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('设备不存在或无权限访问');
      }
    }

    return this.stateService.getAlarmStatistics(deviceId, startTime, endTime);
  }

  /**
   * 获取报警趋势数据
   */
  async getAlarmTrends(
    userId: string,
    deviceId?: string,
    days: number = 7,
  ): Promise<AlarmTrend[]> {
    if (deviceId) {
      // 验证权限
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('设备不存在或无权限访问');
      }
    }

    return this.stateService.getAlarmTrends(deviceId, days);
  }

  /**
   * 获取设备报警摘要
   */
  async getDeviceAlarmSummary(
    deviceId: string,
    userId: string,
  ): Promise<AlarmSummary> {
    // 验证权限
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权限访问');
    }

    return this.stateService.getDeviceAlarmSummary(deviceId);
  }

  /**
   * 批量处理报警
   */
  async batchHandleAlarms(
    alarmIds: string[],
    userId: string,
    status: string = 'handled',
    note?: string,
  ) {
    // 验证所有报警的权限
    for (const alarmId of alarmIds) {
      const alarm = await this.stateService.getAlarmById(alarmId);

      if (!alarm) {
        throw new NotFoundException(`报警 ${alarmId} 不存在`);
      }

      if (alarm.userId !== userId) {
        const userDevice = await this.prisma.userDevice.findFirst({
          where: { deviceId: alarm.deviceId, userId },
        });

        if (!userDevice) {
          throw new NotFoundException(`无权限访问报警 ${alarmId}`);
        }
      }
    }

    const updatedAlarms = await this.stateService.batchUpdateAlarmStatus(
      alarmIds,
      status,
      userId,
      note,
    );

    return {
      message: `已批量处理 ${updatedAlarms.length} 个报警`,
      alarms: updatedAlarms,
    };
  }

  /**
   * 获取待处理报警
   */
  async getPendingAlarms(userId: string, deviceId?: string) {
    if (deviceId) {
      // 验证权限
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('设备不存在或无权限访问');
      }
    }

    const alarms = await this.stateService.getPendingAlarms(deviceId);
    const ownedDeviceIds = new Set(
      (
        await this.prisma.userDevice.findMany({
          where: {
            userId,
            deviceId: { in: alarms.map((alarm) => alarm.deviceId) },
          },
          select: { deviceId: true },
        })
      ).map(({ deviceId: id }) => id),
    );

    return alarms.filter(
      (alarm) => alarm.userId === userId || ownedDeviceIds.has(alarm.deviceId),
    );
  }

  /**
   * 删除报警
   */
  async deleteAlarm(alarmId: string, userId: string) {
    const alarm = await this.stateService.getAlarmById(alarmId);

    if (!alarm) {
      throw new NotFoundException('报警不存在');
    }

    // 验证权限
    if (alarm.userId !== userId) {
      const userDevice = await this.prisma.userDevice.findFirst({
        where: { deviceId: alarm.deviceId, userId },
      });

      if (!userDevice) {
        throw new NotFoundException('无权限访问');
      }
    }

    await this.stateService.deleteAlarm(alarmId);

    return { message: '报警已删除' };
  }

  /**
   * 获取报警规则统计
   */
  async getRuleStatistics(deviceId: string, userId: string) {
    // 验证权限
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('设备不存在或无权限访问');
    }

    return this.ruleEngineService.getRuleStatistics(deviceId);
  }

  /**
   * 清理过期报警
   */
  async cleanupExpiredAlarms(daysToKeep: number = 30) {
    const count = await this.stateService.cleanupExpiredAlarms(daysToKeep);
    return { message: `已清理 ${count} 个过期报警`, count };
  }

  /**
   * 获取通知历史
   */
  getNotificationHistory(alarmId: string) {
    return this.notificationService.getNotificationHistory(alarmId);
  }

  /**
   * 获取通知失败统计
   */
  getNotificationFailureStats() {
    return this.notificationService.getFailureStats();
  }

  /**
   * 重置通知失败统计
   */
  resetNotificationFailureStats(channelType?: string) {
    this.notificationService.resetFailureStats(channelType);
    return { message: '通知失败统计已重置' };
  }
}
