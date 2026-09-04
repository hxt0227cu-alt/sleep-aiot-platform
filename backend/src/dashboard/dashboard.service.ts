import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async getOverview() {
    const [
      totalUsers,
      totalDevices,
      onlineDevices,
      alarmCount,
      recentVitalSigns,
      recentSleepReports,
      lightConfigs,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.device.count(),
      this.prisma.device.count({ where: { status: 'online' } }),
      this.prisma.alarmRecord.count(),
      this.prisma.vitalSignsData.findMany({
        orderBy: { timestamp: 'desc' },
        take: 20,
      }),
      this.prisma.sleepReport.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.deviceConfig.findMany({
        where: { configKey: 'light_state' },
        take: 200,
      }),
    ]);

    const now = Date.now();
    const activeDevices = await this.prisma.device.count({
      where: {
        lastSeen: {
          gte: new Date(now - 15 * 60 * 1000),
        },
      },
    });

    const lightStates = lightConfigs.map((item) => item.configValue as any);
    const lightOnCount = lightStates.filter(
      (item) => item?.power === true,
    ).length;
    const averageBrightness = lightStates.length
      ? Math.round(
          lightStates.reduce(
            (sum, item) => sum + Number(item?.brightness || 0),
            0,
          ) / lightStates.length,
        )
      : 0;
    const latestVitalSign = recentVitalSigns[0] ?? null;
    const latestSleepReport = recentSleepReports[0] ?? null;

    return {
      generatedAt: now,
      users: {
        total: totalUsers,
      },
      devices: {
        total: totalDevices,
        online: onlineDevices,
        offline: Math.max(totalDevices - onlineDevices, 0),
        active: activeDevices,
        onlineRate:
          totalDevices > 0
            ? Number(((onlineDevices / totalDevices) * 100).toFixed(2))
            : 0,
      },
      light: {
        tracked: lightStates.length,
        on: lightOnCount,
        averageBrightness,
      },
      alarms: {
        total: alarmCount,
      },
      sleep: {
        latestReport: latestSleepReport,
        recentReports: recentSleepReports,
      },
      vitalSigns: {
        latest: latestVitalSign,
        recent: recentVitalSigns,
      },
      websocket: {
        connectedDevices: await this.safeRedisKeys('device_online:*'),
      },
    };
  }

  private async safeRedisKeys(pattern: string) {
    try {
      const client = this.redisService.getClient?.();
      if (!client?.keys) {
        return 0;
      }
      const keys = await client.keys(pattern);
      return keys.length;
    } catch {
      return 0;
    }
  }
}
