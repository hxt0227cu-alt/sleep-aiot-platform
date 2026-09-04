import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface AlarmState {
  alarmId: string;
  deviceId: string;
  userId?: string;
  type: string;
  level: string;
  status: string;
  timestamp: Date;
  value?: number;
  threshold?: number;
  message: string;
  handledBy?: string;
  handledAt?: Date;
  note?: string;
}

export interface AlarmStatistics {
  totalAlarms: number;
  pendingAlarms: number;
  handledAlarms: number;
  ignoredAlarms: number;
  criticalAlarms: number;
  warningAlarms: number;
  infoAlarms: number;
  averageResponseTime?: number;
  mostCommonAlarmType?: string;
}

export interface AlarmTrend {
  date: string;
  total: number;
  critical: number;
  warning: number;
  info: number;
}

export interface AlarmSummary {
  deviceId: string;
  deviceName?: string;
  statistics: AlarmStatistics;
  recentAlarms: AlarmState[];
}

@Injectable()
export class AlarmStateService {
  private readonly logger = new Logger(AlarmStateService.name);
  private readonly alarmStateCache = new Map<string, [AlarmState, number]>();
  private readonly CACHE_TTL = 60000; // 1分钟缓存

  constructor(private prisma: PrismaService) {}

  /**
   * 创建报警记录
   */
  async createAlarm(alarmData: {
    deviceId: string;
    userId?: string;
    type: string;
    level: string;
    message: string;
    value?: number;
    threshold?: number;
    timestamp?: Date;
  }): Promise<AlarmState> {
    const device = await this.prisma.device.findFirst({
      where: { id: alarmData.deviceId },
      select: { tenantId: true },
    });
    if (!device?.tenantId) {
      throw new Error(`Device ${alarmData.deviceId} has no tenant assignment`);
    }
    const alarm = await this.prisma.alarmRecord.create({
      data: {
        tenantId: device.tenantId,
        deviceId: alarmData.deviceId,
        userId: alarmData.userId,
        type: alarmData.type,
        level: alarmData.level,
        message: alarmData.message,
        value: alarmData.value,
        threshold: alarmData.threshold,
        timestamp: alarmData.timestamp || new Date(),
        status: 'pending',
      },
    });

    const alarmState = this.mapToAlarmState(alarm);
    this.updateCache(alarmState);

    this.logger.log(
      `Alarm created: ${alarm.id} for device ${alarmData.deviceId}`,
    );
    return alarmState;
  }

  /**
   * 更新报警状态
   */
  async updateAlarmStatus(
    alarmId: string,
    status: string,
    handledBy?: string,
    note?: string,
  ): Promise<AlarmState> {
    const alarm = await this.prisma.alarmRecord.update({
      where: { id: alarmId },
      data: {
        status,
        handledBy,
        handledAt: new Date(),
        note,
      },
    });

    const alarmState = this.mapToAlarmState(alarm);
    this.updateCache(alarmState);

    this.logger.log(`Alarm ${alarmId} status updated to ${status}`);
    return alarmState;
  }

  /**
   * 获取报警详情
   */
  async getAlarmById(alarmId: string): Promise<AlarmState | null> {
    // 检查缓存
    const cached = this.getFromCache(alarmId);
    if (cached) {
      return cached;
    }

    const alarm = await this.prisma.alarmRecord.findUnique({
      where: { id: alarmId },
      include: { device: true, user: true },
    });

    if (!alarm) {
      return null;
    }

    const alarmState = this.mapToAlarmState(alarm);
    this.updateCache(alarmState);

    return alarmState;
  }

  /**
   * 获取设备的报警列表
   */
  async getDeviceAlarms(
    deviceId: string,
    options: {
      status?: string;
      level?: string;
      startTime?: Date;
      endTime?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ alarms: AlarmState[]; total: number }> {
    const where: any = { deviceId };

    if (options.status) {
      where.status = options.status;
    }

    if (options.level) {
      where.level = options.level;
    }

    if (options.startTime || options.endTime) {
      where.timestamp = {};
      if (options.startTime) {
        where.timestamp.gte = options.startTime;
      }
      if (options.endTime) {
        where.timestamp.lte = options.endTime;
      }
    }

    const [alarms, total] = await Promise.all([
      this.prisma.alarmRecord.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: options.limit || 20,
        skip: options.offset || 0,
      }),
      this.prisma.alarmRecord.count({ where }),
    ]);

    return {
      alarms: alarms.map((alarm) => this.mapToAlarmState(alarm)),
      total,
    };
  }

  /**
   * 获取用户的报警列表
   */
  async getUserAlarms(
    userId: string,
    options: {
      deviceId?: string;
      status?: string;
      level?: string;
      startTime?: Date;
      endTime?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ alarms: AlarmState[]; total: number }> {
    const where: any = { userId };

    if (options.deviceId) {
      where.deviceId = options.deviceId;
    }

    if (options.status) {
      where.status = options.status;
    }

    if (options.level) {
      where.level = options.level;
    }

    if (options.startTime || options.endTime) {
      where.timestamp = {};
      if (options.startTime) {
        where.timestamp.gte = options.startTime;
      }
      if (options.endTime) {
        where.timestamp.lte = options.endTime;
      }
    }

    const [alarms, total] = await Promise.all([
      this.prisma.alarmRecord.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: options.limit || 20,
        skip: options.offset || 0,
      }),
      this.prisma.alarmRecord.count({ where }),
    ]);

    return {
      alarms: alarms.map((alarm) => this.mapToAlarmState(alarm)),
      total,
    };
  }

  /**
   * 获取待处理的报警
   */
  async getPendingAlarms(deviceId?: string): Promise<AlarmState[]> {
    const where: any = { status: 'pending' };

    if (deviceId) {
      where.deviceId = deviceId;
    }

    const alarms = await this.prisma.alarmRecord.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    return alarms.map((alarm) => this.mapToAlarmState(alarm));
  }

  /**
   * 获取报警统计信息
   */
  async getAlarmStatistics(
    deviceId?: string,
    startTime?: Date,
    endTime?: Date,
  ): Promise<AlarmStatistics> {
    const where: any = {};

    if (deviceId) {
      where.deviceId = deviceId;
    }

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) {
        where.timestamp.gte = startTime;
      }
      if (endTime) {
        where.timestamp.lte = endTime;
      }
    }

    const alarms = await this.prisma.alarmRecord.findMany({
      where,
      select: {
        status: true,
        level: true,
        handledAt: true,
        timestamp: true,
        type: true,
      },
    });

    const statistics: AlarmStatistics = {
      totalAlarms: alarms.length,
      pendingAlarms: 0,
      handledAlarms: 0,
      ignoredAlarms: 0,
      criticalAlarms: 0,
      warningAlarms: 0,
      infoAlarms: 0,
    };

    const typeCounts = new Map<string, number>();
    const responseTimes: number[] = [];

    for (const alarm of alarms) {
      // 统计状态
      switch (alarm.status) {
        case 'pending':
          statistics.pendingAlarms++;
          break;
        case 'handled':
          statistics.handledAlarms++;
          break;
        case 'ignored':
          statistics.ignoredAlarms++;
          break;
      }

      // 统计级别
      switch (alarm.level) {
        case 'critical':
          statistics.criticalAlarms++;
          break;
        case 'warning':
          statistics.warningAlarms++;
          break;
        case 'info':
          statistics.infoAlarms++;
          break;
      }

      // 统计类型
      const typeCount = typeCounts.get(alarm.type) || 0;
      typeCounts.set(alarm.type, typeCount + 1);

      // 计算响应时间
      if (alarm.handledAt) {
        const responseTime =
          alarm.handledAt.getTime() - alarm.timestamp.getTime();
        responseTimes.push(responseTime);
      }
    }

    // 计算平均响应时间
    if (responseTimes.length > 0) {
      statistics.averageResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;
    }

    // 找出最常见的报警类型
    let maxCount = 0;
    for (const [type, count] of typeCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        statistics.mostCommonAlarmType = type;
      }
    }

    return statistics;
  }

  /**
   * 获取报警趋势数据
   */
  async getAlarmTrends(
    deviceId?: string,
    days: number = 7,
  ): Promise<AlarmTrend[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const where: any = {
      timestamp: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (deviceId) {
      where.deviceId = deviceId;
    }

    const alarms = await this.prisma.alarmRecord.findMany({
      where,
      select: {
        timestamp: true,
        level: true,
      },
    });

    // 按日期分组统计
    const trendMap = new Map<string, AlarmTrend>();

    for (let i = 0; i < days; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];

      trendMap.set(dateStr, {
        date: dateStr,
        total: 0,
        critical: 0,
        warning: 0,
        info: 0,
      });
    }

    for (const alarm of alarms) {
      const dateStr = alarm.timestamp.toISOString().split('T')[0];
      const trend = trendMap.get(dateStr);

      if (trend) {
        trend.total++;
        switch (alarm.level) {
          case 'critical':
            trend.critical++;
            break;
          case 'warning':
            trend.warning++;
            break;
          case 'info':
            trend.info++;
            break;
        }
      }
    }

    return Array.from(trendMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  /**
   * 获取设备报警摘要
   */
  async getDeviceAlarmSummary(deviceId: string): Promise<AlarmSummary> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    const statistics = await this.getAlarmStatistics(deviceId);
    const { alarms: recentAlarms } = await this.getDeviceAlarms(deviceId, {
      limit: 10,
    });

    return {
      deviceId,
      deviceName: device?.name,
      statistics,
      recentAlarms,
    };
  }

  /**
   * 批量更新报警状态
   */
  async batchUpdateAlarmStatus(
    alarmIds: string[],
    status: string,
    handledBy?: string,
    note?: string,
  ): Promise<AlarmState[]> {
    const updatePromises = alarmIds.map((alarmId) =>
      this.updateAlarmStatus(alarmId, status, handledBy, note),
    );

    return Promise.all(updatePromises);
  }

  /**
   * 删除报警记录
   */
  async deleteAlarm(alarmId: string): Promise<void> {
    await this.prisma.alarmRecord.delete({
      where: { id: alarmId },
    });

    this.alarmStateCache.delete(alarmId);
    this.logger.log(`Alarm ${alarmId} deleted`);
  }

  /**
   * 清理过期的报警记录
   */
  async cleanupExpiredAlarms(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.prisma.alarmRecord.deleteMany({
      where: {
        timestamp: {
          lt: cutoffDate,
        },
        status: {
          in: ['handled', 'ignored'],
        },
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired alarms`);
    return result.count;
  }

  /**
   * 映射到报警状态对象
   */
  private mapToAlarmState(alarm: any): AlarmState {
    return {
      alarmId: alarm.id,
      deviceId: alarm.deviceId,
      userId: alarm.userId,
      type: alarm.type,
      level: alarm.level,
      status: alarm.status,
      timestamp: alarm.timestamp,
      value: alarm.value ? Number(alarm.value) : undefined,
      threshold: alarm.threshold ? Number(alarm.threshold) : undefined,
      message: alarm.message,
      handledBy: alarm.handledBy,
      handledAt: alarm.handledAt,
      note: alarm.note,
    };
  }

  /**
   * 更新缓存
   */
  private updateCache(alarmState: AlarmState): void {
    this.alarmStateCache.set(alarmState.alarmId, [alarmState, Date.now()]);
  }

  /**
   *从缓存获取
   */
  private getFromCache(alarmId: string): AlarmState | null {
    const cached = this.alarmStateCache.get(alarmId);

    if (!cached) {
      return null;
    }

    const [alarmState, timestamp] = cached;

    // 检查缓存是否过期
    if (Date.now() - timestamp > this.CACHE_TTL) {
      this.alarmStateCache.delete(alarmId);
      return null;
    }

    return alarmState;
  }

  /**
   * 清除缓存
   */
  clearCache(alarmId?: string): void {
    if (alarmId) {
      this.alarmStateCache.delete(alarmId);
    } else {
      this.alarmStateCache.clear();
    }
  }
}
