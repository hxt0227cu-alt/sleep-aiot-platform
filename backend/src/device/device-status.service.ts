import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WebSocketService } from '../websocket/websocket.service';
import { LeaderLockService } from '../redis/leader-lock.service';

export interface DeviceStatus {
  deviceId: string;
  online: boolean;
  lastSeen: number;
  status: string;
  firmwareVersion?: string;
  batteryLevel?: number;
  signalStrength?: number;
}

@Injectable()
export class DeviceStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceStatusService.name);
  private readonly OFFLINE_TIMEOUT = 300000;
  private readonly CHECK_INTERVAL = 60000;
  private statusCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
    private wsService: WebSocketService,
    private leaderLock: LeaderLockService,
  ) {}

  onModuleInit() {
    this.logger.log('Device Status Service initialized');
    this.startStatusCheck();
  }

  onModuleDestroy() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  private startStatusCheck(): void {
    // 认领式协调：同一时刻只有持有 leader 锁的副本执行巡检，避免 N 副本各自扫全表写库
    // （见 ADR-015）。ttl 取检查间隔的 90%，留出余量防止上一轮未释放时下一轮重叠。
    this.statusCheckInterval = setInterval(async () => {
      await this.leaderLock.runIfLeader(
        'device-status:periodic-check',
        Math.floor(this.CHECK_INTERVAL * 0.9),
        () => this.checkDeviceStatuses(),
      );
    }, this.CHECK_INTERVAL);
  }

  private async checkDeviceStatuses(): Promise<void> {
    const cutoff = new Date(Date.now() - this.OFFLINE_TIMEOUT);
    const offlineDevices = await this.prisma.device.findMany({
      where: { status: 'online', lastSeen: { lt: cutoff } },
      select: { id: true, lastSeen: true },
    });

    for (const device of offlineDevices) {
      const result = await this.prisma.device.updateMany({
        where: {
          id: device.id,
          status: 'online',
          lastSeen: device.lastSeen,
        },
        data: { status: 'offline' },
      });
      if (result.count > 0) {
        await this.writeStatusCache({
          deviceId: device.id,
          online: false,
          status: 'offline',
          lastSeen: device.lastSeen?.getTime() ?? 0,
        });
        this.wsService.sendDeviceStatus(device.id, false);
      }
    }

    this.logger.debug(
      `Device status check completed. Offline devices: ${offlineDevices.length}`,
    );
  }

  async updateDeviceStatus(
    deviceId: string,
    status: Partial<DeviceStatus>,
  ): Promise<void> {
    const sourceLastSeen = status.lastSeen ?? Date.now();
    const updatedStatus: DeviceStatus = {
      ...status,
      deviceId,
      lastSeen: sourceLastSeen,
      online: true,
      status: 'online',
    };

    const result = await this.prisma.device.updateMany({
      where: {
        id: deviceId,
        OR: [
          { lastSeen: null },
          { lastSeen: { lte: new Date(sourceLastSeen) } },
        ],
      },
      data: {
        status: 'online',
        lastSeen: new Date(sourceLastSeen),
      },
    });
    if (result.count === 0) return;

    await this.writeStatusCache(updatedStatus);

    this.wsService.sendDeviceStatus(deviceId, true);

    this.logger.debug(`Device ${deviceId} status updated`);
  }

  async markDeviceOffline(deviceId: string): Promise<void> {
    const current = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { status: true, lastSeen: true, firmwareVersion: true },
    });
    if (!current || current.status !== 'online') return;

    const result = await this.prisma.device.updateMany({
      where: { id: deviceId, status: 'online', lastSeen: current.lastSeen },
      data: { status: 'offline' },
    });
    if (result.count === 0) return;

    await this.writeStatusCache({
      deviceId,
      online: false,
      status: 'offline',
      lastSeen: current.lastSeen?.getTime() ?? 0,
      firmwareVersion: current.firmwareVersion ?? undefined,
    });

    this.wsService.sendDeviceStatus(deviceId, false);

    this.logger.warn(`Device ${deviceId} marked as offline`);
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    const now = Date.now();
    const redisStatus = await this.redisService.get(
      `device_status:${deviceId}`,
    );
    if (redisStatus) {
      const parsedStatus = JSON.parse(redisStatus) as Partial<DeviceStatus> &
        Record<string, unknown>;
      const lastSeen =
        Number(parsedStatus.lastSeen ?? (parsedStatus as any).last_seen) || 0;
      const isOnline =
        (parsedStatus.online === true || parsedStatus.status === 'online') &&
        now - lastSeen < this.OFFLINE_TIMEOUT;
      const status: DeviceStatus = {
        deviceId,
        online: isOnline,
        lastSeen,
        status: isOnline ? 'online' : 'offline',
        firmwareVersion:
          parsedStatus.firmwareVersion ||
          (parsedStatus.firmware_version as string | undefined),
        batteryLevel:
          parsedStatus.batteryLevel ??
          (parsedStatus.battery_level as number | undefined),
        signalStrength:
          parsedStatus.signalStrength ??
          (parsedStatus.signal_strength as number | undefined),
      };
      return status;
    }

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      return null;
    }

    const lastSeen = device.lastSeen?.getTime() || 0;
    const isOnline =
      device.status === 'online' && now - lastSeen < this.OFFLINE_TIMEOUT;

    return {
      deviceId: device.id,
      online: isOnline,
      lastSeen,
      status: isOnline ? 'online' : 'offline',
      firmwareVersion: device.firmwareVersion || undefined,
    };
  }

  async getAllDeviceStatuses(): Promise<DeviceStatus[]> {
    const devices = await this.prisma.device.findMany();

    const statuses: DeviceStatus[] = [];

    for (const device of devices) {
      const status = await this.getDeviceStatus(device.id);
      if (status) {
        statuses.push(status);
      }
    }

    return statuses;
  }

  async getOnlineDevices(): Promise<DeviceStatus[]> {
    const statuses = await this.getAllDeviceStatuses();
    return statuses.filter((status) => status.online);
  }

  async getOfflineDevices(): Promise<DeviceStatus[]> {
    const statuses = await this.getAllDeviceStatuses();
    return statuses.filter((status) => !status.online);
  }

  async getDeviceStatusByUser(userId: string): Promise<DeviceStatus[]> {
    const userDevices = await this.prisma.userDevice.findMany({
      where: { userId },
      include: { device: true },
    });

    const statuses: DeviceStatus[] = [];

    for (const userDevice of userDevices) {
      const status = await this.getDeviceStatus(userDevice.deviceId);
      if (status) {
        statuses.push(status);
      }
    }

    return statuses;
  }

  async clearDeviceStatus(deviceId: string): Promise<void> {
    await this.redisService.del(
      `device_status:${deviceId}`,
      `device_online:${deviceId}`,
    );
    this.logger.debug(`Device ${deviceId} status cleared`);
  }

  async clearAllDeviceStatuses(): Promise<void> {
    const keys = [
      ...(await this.redisService.keys('device_status:*')),
      ...(await this.redisService.keys('device_online:*')),
    ];
    if (keys.length > 0) {
      await this.redisService.del(...keys);
    }

    this.logger.log('All device statuses cleared');
  }

  private async writeStatusCache(status: DeviceStatus): Promise<void> {
    await this.redisService.set(
      `device_status:${status.deviceId}`,
      JSON.stringify(status),
      300,
    );
    await this.redisService.set(
      `device_online:${status.deviceId}`,
      status.online ? '1' : '0',
      300,
    );
  }
}
