import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { DeviceService } from '../device/device.service';

@Injectable()
export class ScheduledDeviceActionExecutorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    ScheduledDeviceActionExecutorService.name,
  );
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceService: DeviceService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      void this.processDueActions();
    }, 15000);
    void this.processDueActions();
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async processDueActions() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      const dueActions = await this.prisma.scheduledDeviceAction.findMany({
        where: {
          status: 'pending',
          executeAt: {
            lte: new Date(),
          },
        },
        orderBy: { executeAt: 'asc' },
        take: 20,
      });

      for (const action of dueActions) {
        const claimResult = await this.prisma.scheduledDeviceAction.updateMany({
          where: {
            id: action.id,
            status: 'pending',
          },
          data: {
            status: 'processing',
          },
        });

        if (claimResult.count === 0) {
          continue;
        }

        try {
          await this.deviceService.sendCommand(action.deviceId, action.userId, {
            command: action.command as any,
            params: (action.params as Record<string, any>) || {},
            timeout: 8000,
          });

          await this.prisma.scheduledDeviceAction.update({
            where: { id: action.id },
            data: {
              status: 'completed',
              executedAt: new Date(),
              errorMessage: null,
            },
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Scheduled action failed';
          this.logger.error(
            `Scheduled action ${action.id} failed: ${errorMessage}`,
          );
          await this.prisma.scheduledDeviceAction.update({
            where: { id: action.id },
            data: {
              status: 'failed',
              executedAt: new Date(),
              errorMessage,
            },
          });
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
