import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OtaProgressDto, OtaStatus } from './dto/ota-progress.dto';

export interface FirmwareInfo {
  version: string;
  deviceType: string;
  fileSize: number;
  downloadUrl: string;
  releaseNotes: string;
  md5: string;
}

@Injectable()
export class OtaService {
  private readonly defaultFirmwareVersions: FirmwareInfo[] = [
    {
      version: '1.1.0',
      deviceType: 'sleep_lamp',
      fileSize: 1024000,
      downloadUrl: 'https://cdn.sleep-lamp.com/firmware/v1.1.0.bin',
      releaseNotes: 'Fix heart-rate detection and improve power consumption.',
      md5: 'abc123def4567890abc123def4567890',
    },
    {
      version: '1.2.0',
      deviceType: 'sleep_lamp',
      fileSize: 1050000,
      downloadUrl: 'https://cdn.sleep-lamp.com/firmware/v1.2.0.bin',
      releaseNotes: 'Add voice-control support and improve BLE pairing.',
      md5: 'def456ghi789012def456ghi78901200',
    },
  ];

  constructor(private prisma: PrismaService) {}

  async checkUpdate(deviceId: string, userId: string) {
    const device = await this.ensureDeviceAccess(deviceId, userId);
    const currentVersion = device.firmwareVersion || '0.0.0';
    const latestVersion = await this.getLatestFirmwareVersion(device.type);
    const hasUpdate = this.compareVersions(currentVersion, latestVersion) < 0;

    if (!hasUpdate) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        message: 'Firmware is already up to date',
      };
    }

    const firmwareInfo = await this.getFirmwareInfo(latestVersion);

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      updateType: this.getUpdateType(currentVersion, latestVersion),
      ...firmwareInfo,
    };
  }

  async startUpdate(
    deviceId: string,
    userId: string,
    version: string,
    force = false,
  ) {
    await this.ensureDeviceAccess(deviceId, userId);
    const firmwareInfo = await this.getFirmwareInfo(version);

    if (!firmwareInfo.downloadUrl) {
      throw new NotFoundException('Firmware version does not exist');
    }

    const progressData = {
      version,
      progress: 0,
      status: OtaStatus.DOWNLOADING,
      force,
      downloadUrl: firmwareInfo.downloadUrl,
      md5: firmwareInfo.md5,
      fileSize: firmwareInfo.fileSize,
      timestamp: Date.now(),
    };

    await this.saveProgress(deviceId, progressData);
    await this.appendHistory(deviceId, {
      action: 'start',
      ...progressData,
    });

    return {
      message: 'OTA update started',
      deviceId,
      ...progressData,
    };
  }

  async cancelUpdate(deviceId: string, userId: string) {
    await this.ensureDeviceAccess(deviceId, userId);
    const current = await this.getStoredProgress(deviceId);
    const progressData = {
      ...(current || {}),
      version: current?.version || 'unknown',
      progress: current?.progress || 0,
      status: OtaStatus.CANCELLED,
      timestamp: Date.now(),
    };

    await this.saveProgress(deviceId, progressData);
    await this.appendHistory(deviceId, {
      action: 'cancel',
      ...progressData,
    });

    return {
      message: 'OTA update cancelled',
      deviceId,
      ...progressData,
    };
  }

  async getProgress(deviceId: string, userId: string) {
    await this.ensureDeviceAccess(deviceId, userId);
    const progress = await this.getStoredProgress(deviceId);

    return {
      deviceId,
      ...(progress || {
        version: '',
        progress: 0,
        status: 'idle',
        timestamp: 0,
      }),
    };
  }

  async reportProgress(progressDto: OtaProgressDto) {
    const { deviceId, version, progress, status, error } = progressDto;

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device does not exist');
    }

    const progressData = {
      version,
      progress,
      status,
      error,
      timestamp: Date.now(),
    };

    await this.saveProgress(deviceId, progressData);
    await this.appendHistory(deviceId, {
      action: 'progress',
      ...progressData,
    });

    if (status === OtaStatus.COMPLETED) {
      await this.prisma.device.update({
        where: { id: deviceId },
        data: { firmwareVersion: version },
      });
    }

    return { message: 'OTA progress reported successfully' };
  }

  async getHistory(deviceId: string, userId: string, page = 1, pageSize = 20) {
    await this.ensureDeviceAccess(deviceId, userId);
    const config = await this.prisma.deviceConfig.findUnique({
      where: { deviceId_configKey: { deviceId, configKey: 'ota_history' } },
    });
    const history = Array.isArray(config?.configValue)
      ? config.configValue
      : [];
    const start = (page - 1) * pageSize;

    return {
      deviceId,
      page,
      pageSize,
      total: history.length,
      records: history.slice(start, start + pageSize),
    };
  }

  async getVersions(deviceType?: string, latestOnly = false) {
    const records = await this.prisma.firmwareVersion.findMany({
      where: {
        isActive: true,
        ...(deviceType ? { deviceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    const dbVersions = records.map((record) => ({
      version: record.version,
      deviceType: record.deviceType,
      fileSize: record.fileSize,
      downloadUrl: record.fileUrl,
      releaseNotes: record.changelog || '',
      md5: record.checksum,
      createdAt: record.createdAt.getTime(),
    }));

    const versions = (
      dbVersions.length > 0 ? dbVersions : this.defaultFirmwareVersions
    )
      .filter((item) => !deviceType || item.deviceType === deviceType)
      .sort((a, b) => this.compareVersions(b.version, a.version));

    return {
      versions: latestOnly ? versions.slice(0, 1) : versions,
    };
  }

  async uploadFirmware(body: {
    version: string;
    deviceType: string;
    fileUrl: string;
    fileSize: number;
    checksum: string;
    changelog?: string;
  }) {
    const record = await this.prisma.firmwareVersion.upsert({
      where: { version: body.version },
      update: {
        deviceType: body.deviceType,
        fileUrl: body.fileUrl,
        fileSize: body.fileSize,
        checksum: body.checksum,
        changelog: body.changelog,
        isActive: true,
      },
      create: {
        version: body.version,
        deviceType: body.deviceType,
        fileUrl: body.fileUrl,
        fileSize: body.fileSize,
        checksum: body.checksum,
        changelog: body.changelog,
      },
    });

    return {
      message: 'Firmware uploaded successfully',
      version: record.version,
      deviceType: record.deviceType,
    };
  }

  async deleteVersion(version: string) {
    const record = await this.prisma.firmwareVersion.findUnique({
      where: { version },
    });

    if (!record || !record.isActive) {
      throw new NotFoundException('Firmware version does not exist');
    }

    await this.prisma.firmwareVersion.update({
      where: { version },
      data: { isActive: false },
    });

    return {
      message: 'Firmware version deleted successfully',
      version,
    };
  }

  private async ensureDeviceAccess(deviceId: string, userId: string) {
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException(
        'Device does not exist or is not bound to the current user',
      );
    }

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device does not exist');
    }

    return device;
  }

  private async getLatestFirmwareVersion(
    deviceType = 'sleep_lamp',
  ): Promise<string> {
    const result = await this.getVersions(deviceType, true);
    return result.versions[0]?.version || '1.1.0';
  }

  private async getFirmwareInfo(version: string): Promise<FirmwareInfo> {
    const record = await this.prisma.firmwareVersion.findUnique({
      where: { version },
    });

    if (record?.isActive) {
      return {
        version: record.version,
        deviceType: record.deviceType,
        fileSize: record.fileSize,
        downloadUrl: record.fileUrl,
        releaseNotes: record.changelog || '',
        md5: record.checksum,
      };
    }

    return (
      this.defaultFirmwareVersions.find((item) => item.version === version) || {
        version,
        deviceType: 'sleep_lamp',
        fileSize: 0,
        downloadUrl: '',
        releaseNotes: '',
        md5: '',
      }
    );
  }

  private async getStoredProgress(deviceId: string): Promise<any | null> {
    const config = await this.prisma.deviceConfig.findUnique({
      where: { deviceId_configKey: { deviceId, configKey: 'ota_progress' } },
    });

    return config?.configValue || null;
  }

  private async saveProgress(
    deviceId: string,
    progressData: Record<string, any>,
  ) {
    await this.prisma.deviceConfig.upsert({
      where: { deviceId_configKey: { deviceId, configKey: 'ota_progress' } },
      create: {
        deviceId,
        configKey: 'ota_progress',
        configValue: progressData,
      },
      update: {
        configValue: progressData,
      },
    });
  }

  private async appendHistory(deviceId: string, record: Record<string, any>) {
    const config = await this.prisma.deviceConfig.findUnique({
      where: { deviceId_configKey: { deviceId, configKey: 'ota_history' } },
    });
    const history = Array.isArray(config?.configValue)
      ? config.configValue
      : [];
    const nextHistory = [record, ...history].slice(0, 100);

    await this.prisma.deviceConfig.upsert({
      where: { deviceId_configKey: { deviceId, configKey: 'ota_history' } },
      create: {
        deviceId,
        configKey: 'ota_history',
        configValue: nextHistory,
      },
      update: {
        configValue: nextHistory,
      },
    });
  }

  private compareVersions(left: string, right: string): number {
    const leftParts = left.split('-')[0].split('.').map(Number);
    const rightParts = right.split('-')[0].split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const leftPart = leftParts[i] || 0;
      const rightPart = rightParts[i] || 0;

      if (leftPart < rightPart) {
        return -1;
      }
      if (leftPart > rightPart) {
        return 1;
      }
    }

    return 0;
  }

  private getUpdateType(current: string, latest: string): string {
    const currentParts = current.split('-')[0].split('.').map(Number);
    const latestParts = latest.split('-')[0].split('.').map(Number);

    if ((latestParts[0] || 0) > (currentParts[0] || 0)) {
      return 'major';
    }
    if ((latestParts[1] || 0) > (currentParts[1] || 0)) {
      return 'minor';
    }
    return 'patch';
  }
}
