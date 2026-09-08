import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TenantContext } from '../tenant/tenant-context';
import { CreateSleepDataDto } from './dto/create-sleep-data.dto';
import { CreateSleepDiaryDto } from './dto/create-sleep-diary.dto';
import { CreateSleepRelaxRecordDto } from './dto/create-sleep-relax-record.dto';
import { CreateSleepRoutineRecordDto } from './dto/create-sleep-routine-record.dto';
import { SleepHistoryDto } from './dto/sleep-history.dto';
import { SleepPlanDto } from './dto/sleep-plan.dto';
import {
  SleepRoutineStepDto,
  SleepRoutineTemplateDto,
} from './dto/sleep-routine-template.dto';
import { SleepReportDto } from './dto/sleep-report.dto';
import { SleepTrendDto } from './dto/sleep-trend.dto';
import { UpdateSleepDiaryDto } from './dto/update-sleep-diary.dto';

type SleepState =
  'awake' | 'light_sleep' | 'deep_sleep' | 'rem_sleep' | 'unknown';

interface SleepStageResult {
  state: SleepState;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  confidence: number;
}

@Injectable()
export class SleepService {
  private readonly logger = new Logger(SleepService.name);
  private readonly defaultRoutineSteps: SleepRoutineStepDto[] = [
    { id: 'shower', name: '洗澡', sortOrder: 1, isFixed: true, enabled: true },
    {
      id: 'pajamas',
      name: '换睡衣',
      sortOrder: 2,
      isFixed: true,
      enabled: true,
    },
    { id: 'read', name: '阅读', sortOrder: 3, isFixed: false, enabled: true },
    { id: 'bed', name: '上床睡觉', sortOrder: 4, isFixed: true, enabled: true },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async getRealtimeData(deviceId: string, userId: string) {
    await this.assertDeviceAccess(deviceId, userId);

    const cachedData = await this.safeRedisGet(`vital_signs:${deviceId}`);
    if (cachedData) {
      return JSON.parse(cachedData);
    }

    const latestData = await this.prisma.vitalSignsData.findFirst({
      where: { deviceId },
      orderBy: { timestamp: 'desc' },
    });

    return this.toRealtimeResponse(deviceId, latestData);
  }

  async getHistoryData(
    deviceId: string,
    userId: string,
    historyDto: SleepHistoryDto,
  ) {
    await this.assertDeviceAccess(deviceId, userId);

    const startDate = new Date(historyDto.startTime);
    const endDate = new Date(historyDto.endTime);
    const interval = historyDto.interval ?? 60;
    const metrics = (
      historyDto.metrics ?? 'heart_rate,breathing_rate,body_movement'
    )
      .split(',')
      .map((metric) => metric.trim())
      .filter(Boolean);

    const records = await this.prisma.vitalSignsData.findMany({
      where: {
        deviceId,
        timestamp: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    const aggregated = this.aggregateHistory(records, interval);
    const response: Record<string, any> = {
      deviceId,
      startTime: historyDto.startTime,
      endTime: historyDto.endTime,
      interval,
      metrics: {},
    };

    if (metrics.includes('heart_rate')) {
      const heartRateSeries = aggregated.map((item) => ({
        timestamp: item.timestamp.getTime(),
        value: item.heartRate ?? 0,
      }));
      response.metrics.heartRate = heartRateSeries;
      response.metrics.heart_rate = heartRateSeries;
    }

    if (metrics.includes('breathing_rate')) {
      const breathingRateSeries = aggregated.map((item) => ({
        timestamp: item.timestamp.getTime(),
        value: item.breathingRate ?? 0,
      }));
      response.metrics.breathingRate = breathingRateSeries;
      response.metrics.breathing_rate = breathingRateSeries;
    }

    if (metrics.includes('body_movement')) {
      const bodyMovementSeries = aggregated.map((item) => ({
        timestamp: item.timestamp.getTime(),
        value: item.bodyMovement ?? 0,
      }));
      response.metrics.bodyMovement = bodyMovementSeries;
      response.metrics.body_movement = bodyMovementSeries;
    }

    return response;
  }

  async getReport(deviceId: string, userId: string, reportDto: SleepReportDto) {
    await this.assertDeviceAccess(deviceId, userId);

    const reportDate = this.toDateOnly(reportDto.date);
    let report = await this.prisma.sleepReport.findFirst({
      where: { deviceId, reportDate },
      orderBy: { createdAt: 'desc' },
    });

    if (!report) {
      report = await this.generateDailyReport(deviceId, userId, reportDate);
    }

    return this.toReportResponse(deviceId, reportDate, report);
  }

  async getTrend(deviceId: string, userId: string, trendDto: SleepTrendDto) {
    await this.assertDeviceAccess(deviceId, userId);

    const days = Math.min(Math.max(trendDto.days ?? 7, 1), 30);
    const endDate = this.toDateOnly();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (days - 1));

    const reports = await this.prisma.sleepReport.findMany({
      where: {
        deviceId,
        reportDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { reportDate: 'asc' },
    });

    const reportMap = new Map(
      reports.map((report) => [this.formatDateOnly(report.reportDate), report]),
    );
    const todayKey = this.formatDateOnly(endDate);
    if (!reportMap.has(todayKey)) {
      const todayReport = await this.getOrCreateDailyReport(
        deviceId,
        userId,
        endDate,
      );
      if (todayReport) {
        reportMap.set(todayKey, todayReport);
      }
    }

    const requestedMetrics = this.parseTrendMetrics(trendDto.metric);
    const dates = this.listDateRange(startDate, endDate);
    const sleepScoreSeries = dates.map((date) => ({
      date: this.formatDateOnly(date),
      value: reportMap.get(this.formatDateOnly(date))?.sleepScore ?? 0,
    }));
    const sleepDurationSeries = dates.map((date) => ({
      date: this.formatDateOnly(date),
      value: this.toClientSleepDuration(
        reportMap.get(this.formatDateOnly(date))?.sleepDuration,
      ).total,
    }));
    const efficiencySeries = dates.map((date) => ({
      date: this.formatDateOnly(date),
      value: reportMap.get(this.formatDateOnly(date))?.sleepEfficiency ?? 0,
    }));

    const trend: Record<string, Array<{ date: string; value: number }>> = {};
    if (requestedMetrics.has('sleep_score')) {
      trend.sleepScore = sleepScoreSeries;
      trend.sleep_score = sleepScoreSeries;
    }
    if (requestedMetrics.has('sleep_duration')) {
      trend.sleepDuration = sleepDurationSeries;
      trend.sleep_duration = sleepDurationSeries;
    }
    if (requestedMetrics.has('efficiency')) {
      trend.efficiency = efficiencySeries;
    }

    return {
      deviceId,
      period: `${days}_days`,
      trend,
    };
  }

  async getSleepPlan(userId: string) {
    const plan = await this.prisma.sleepPlan.findUnique({
      where: { userId },
    });

    if (!plan) {
      return {
        bedTime: '23:00',
        sleepDuration: 8,
        wakeTime: '07:00',
        reminderEnabled: true,
        updatedAt: null,
      };
    }

    return {
      bedTime: plan.bedTime,
      sleepDuration: plan.sleepDuration,
      wakeTime: plan.wakeTime,
      reminderEnabled: plan.reminderEnabled,
      updatedAt: plan.updatedAt,
    };
  }

  async updateSleepPlan(userId: string, dto: SleepPlanDto) {
    const tenantId = this.requireTenantId();
    const plan = await this.prisma.sleepPlan.upsert({
      where: { userId },
      create: {
        tenantId,
        userId,
        bedTime: dto.bedTime,
        sleepDuration: dto.sleepDuration,
        wakeTime: dto.wakeTime,
        reminderEnabled: dto.reminderEnabled,
      },
      update: {
        bedTime: dto.bedTime,
        sleepDuration: dto.sleepDuration,
        wakeTime: dto.wakeTime,
        reminderEnabled: dto.reminderEnabled,
      },
    });

    return {
      bedTime: plan.bedTime,
      sleepDuration: plan.sleepDuration,
      wakeTime: plan.wakeTime,
      reminderEnabled: plan.reminderEnabled,
      updatedAt: plan.updatedAt,
    };
  }

  async getRoutineTemplate(userId: string) {
    const template = await this.prisma.sleepRoutineTemplate.findUnique({
      where: { userId },
    });

    return {
      steps: template
        ? this.normalizeRoutineSteps(template.steps)
        : this.defaultRoutineSteps,
      updatedAt: template?.updatedAt ?? null,
    };
  }

  async updateRoutineTemplate(userId: string, dto: SleepRoutineTemplateDto) {
    const steps = this.toJsonArray(this.sortRoutineSteps(dto.steps));
    const template = await this.prisma.sleepRoutineTemplate.upsert({
      where: { userId },
      create: { userId, steps },
      update: { steps },
    });

    return {
      steps: this.normalizeRoutineSteps(template.steps),
      updatedAt: template.updatedAt,
    };
  }

  async createRoutineRecord(userId: string, dto: CreateSleepRoutineRecordDto) {
    const tenantId = this.requireTenantId();
    const record = await this.prisma.sleepRoutineRecord.create({
      data: {
        tenantId,
        userId,
        date: this.toDateOnly(dto.date),
        startedAt: new Date(dto.startedAt),
        completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
        stepsSnapshot: this.toJsonArray(
          this.sortRoutineSteps(dto.stepsSnapshot),
        ),
        finished: dto.finished,
      },
    });

    return this.toRoutineRecordResponse(record);
  }

  async getRoutineRecords(userId: string, limit: number) {
    const records = await this.prisma.sleepRoutineRecord.findMany({
      where: { userId },
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
      take: this.normalizeLimit(limit),
    });

    return records.map((record) => this.toRoutineRecordResponse(record));
  }

  async createDiary(userId: string, dto: CreateSleepDiaryDto) {
    await this.assertOptionalDeviceAccess(dto.deviceId, userId);
    const tenantId = this.requireTenantId();

    const diary = await this.prisma.sleepDiary.create({
      data: {
        tenantId,
        userId,
        deviceId: dto.deviceId ?? null,
        date: this.toDateOnly(dto.date),
        bedTime: dto.bedTime,
        wakeTime: dto.wakeTime,
        fallAsleepMinutes: dto.fallAsleepMinutes,
        quality: dto.quality,
        summary: dto.summary,
      },
    });

    return this.toDiaryResponse(diary);
  }

  async getDiaries(userId: string, limit: number) {
    const diaries = await this.prisma.sleepDiary.findMany({
      where: { userId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: this.normalizeLimit(limit),
    });

    return diaries.map((diary) => this.toDiaryResponse(diary));
  }

  async getDiary(userId: string, diaryId: string) {
    const diary = await this.prisma.sleepDiary.findFirst({
      where: { id: diaryId, userId },
    });

    if (!diary) {
      throw new NotFoundException('Sleep diary not found');
    }

    return this.toDiaryResponse(diary);
  }

  async updateDiary(userId: string, diaryId: string, dto: UpdateSleepDiaryDto) {
    const existingDiary = await this.prisma.sleepDiary.findFirst({
      where: { id: diaryId, userId },
    });

    if (!existingDiary) {
      throw new NotFoundException('Sleep diary not found');
    }

    await this.assertOptionalDeviceAccess(dto.deviceId, userId);

    const diary = await this.prisma.sleepDiary.update({
      where: { id: diaryId },
      data: {
        deviceId:
          dto.deviceId !== undefined ? dto.deviceId : existingDiary.deviceId,
        date: dto.date ? this.toDateOnly(dto.date) : existingDiary.date,
        bedTime: dto.bedTime ?? existingDiary.bedTime,
        wakeTime: dto.wakeTime ?? existingDiary.wakeTime,
        fallAsleepMinutes:
          dto.fallAsleepMinutes ?? existingDiary.fallAsleepMinutes,
        quality: dto.quality ?? existingDiary.quality,
        summary: dto.summary ?? existingDiary.summary,
      },
    });

    return this.toDiaryResponse(diary);
  }

  async createRelaxRecord(userId: string, dto: CreateSleepRelaxRecordDto) {
    const tenantId = this.requireTenantId();
    const record = await this.prisma.sleepRelaxRecord.create({
      data: {
        tenantId,
        userId,
        methodId: dto.methodId,
        methodName: dto.methodName,
        durationSeconds: dto.durationSeconds,
        completedAt: dto.completedAt ? new Date(dto.completedAt) : new Date(),
        status: dto.status ?? 'completed',
      },
    });

    return this.toRelaxRecordResponse(record);
  }

  async getRelaxRecords(userId: string, limit: number) {
    const records = await this.prisma.sleepRelaxRecord.findMany({
      where: { userId },
      orderBy: { completedAt: 'desc' },
      take: this.normalizeLimit(limit),
    });

    return records.map((record) => this.toRelaxRecordResponse(record));
  }

  async createSleepData(dto: CreateSleepDataDto) {
    const tenantId = await this.requireDeviceTenant(dto.deviceId);
    const timestamp = new Date(dto.timestamp);
    const bodyMovement =
      dto.movement === undefined || dto.movement === null
        ? null
        : Math.round(dto.movement * 100) / 100;
    const sleepState = this.normalizeSleepState(dto.sleepState);
    const sleepScore = this.calculateInstantSleepScore({
      heartRate: dto.heartRate ?? null,
      breathingRate: dto.breathingRate ?? null,
      bodyMovement,
      sleepState,
    });
    const confidence = this.calculateConfidence({
      heartRate: dto.heartRate ?? null,
      breathingRate: dto.breathingRate ?? null,
      bodyMovement,
      sleepState,
    });

    const savedData = await this.prisma.vitalSignsData.create({
      data: {
        tenantId,
        deviceId: dto.deviceId,
        timestamp,
        heartRate: this.normalizeHeartRate(dto.heartRate),
        breathingRate: this.normalizeBreathingRate(dto.breathingRate),
        bodyMovement,
        sleepState,
        sleepScore,
        confidence,
        rawData: {
          receivedAt: new Date().toISOString(),
          payload: dto,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const realtimeResponse = this.toRealtimeResponse(dto.deviceId, savedData);
    await this.safeRedisSet(
      `vital_signs:${dto.deviceId}`,
      JSON.stringify(realtimeResponse),
      60,
    );

    return savedData;
  }

  private async generateDailyReport(
    deviceId: string,
    userId: string,
    reportDate: Date,
  ) {
    const tenantId = this.requireTenantId();
    this.logger.log(
      `Generating sleep report for device ${deviceId} on ${this.formatDateOnly(reportDate)}`,
    );

    const startOfDay = new Date(reportDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(reportDate);
    endOfDay.setHours(23, 59, 59, 999);

    const records = await this.prisma.vitalSignsData.findMany({
      where: {
        deviceId,
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    let reportData: {
      userId: string;
      sleepScore: number;
      sleepDuration: Prisma.InputJsonValue;
      sleepEfficiency: number;
      sleepLatency: number;
      awakenings: number;
      sleepStructure: Prisma.InputJsonValue;
      vitalSigns: Prisma.InputJsonValue;
      healthSuggestions: Prisma.InputJsonValue;
    };

    if (records.length === 0) {
      reportData = {
        userId,
        sleepScore: 0,
        sleepDuration: {
          total: 0,
          deep: 0,
          light: 0,
          rem: 0,
          awake: 0,
        },
        sleepEfficiency: 0,
        sleepLatency: 0,
        awakenings: 0,
        sleepStructure: [],
        vitalSigns: {
          avgHeartRate: 0,
          minHeartRate: 0,
          maxHeartRate: 0,
          avgBreathingRate: 0,
          minBreathingRate: 0,
          maxBreathingRate: 0,
        },
        healthSuggestions: ['No sleep data available yet.'],
      };
    } else {
      const stages = this.buildSleepStages(records);
      const duration = this.calculateSleepDuration(stages);
      const observedMinutes = Math.max(
        1,
        Math.round(
          (records[records.length - 1].timestamp.getTime() -
            records[0].timestamp.getTime()) /
            60000,
        ),
      );
      const sleepMinutes = duration.total - duration.awake;
      const efficiency = Math.max(
        0,
        Math.min(100, Math.round((sleepMinutes / observedMinutes) * 100)),
      );
      const latency = this.calculateSleepLatency(stages);
      const awakenings = stages.filter(
        (stage) => stage.state === 'awake',
      ).length;
      const sleepScore = this.calculateDailySleepScore({
        duration,
        efficiency,
        awakenings,
        latency,
      });
      const vitalSigns = this.aggregateVitalSigns(records);
      const healthSuggestions = this.generateHealthSuggestions({
        duration,
        efficiency,
        awakenings,
        latency,
        vitalSigns,
      });

      reportData = {
        userId,
        sleepScore,
        sleepDuration: duration,
        sleepEfficiency: efficiency,
        sleepLatency: latency,
        awakenings,
        sleepStructure: stages.map((stage) => ({
          state: stage.state,
          startTime: stage.startTime.getTime(),
          endTime: stage.endTime.getTime(),
          durationSeconds: stage.durationSeconds,
          confidence: stage.confidence,
        })),
        vitalSigns: vitalSigns,
        healthSuggestions: healthSuggestions,
      };
    }

    return this.prisma.sleepReport.upsert({
      where: {
        deviceId_reportDate: {
          deviceId,
          reportDate,
        },
      },
      create: {
        tenantId,
        deviceId,
        reportDate,
        ...reportData,
      },
      update: reportData,
    });

    if (records.length === 0) {
      return this.prisma.sleepReport.create({
        data: {
          tenantId,
          deviceId,
          userId,
          reportDate,
          sleepScore: 0,
          sleepDuration: {
            total: 0,
            deep: 0,
            light: 0,
            rem: 0,
            awake: 0,
          },
          sleepEfficiency: 0,
          sleepLatency: 0,
          awakenings: 0,
          sleepStructure: [],
          vitalSigns: {
            avgHeartRate: 0,
            minHeartRate: 0,
            maxHeartRate: 0,
            avgBreathingRate: 0,
            minBreathingRate: 0,
            maxBreathingRate: 0,
          },
          healthSuggestions: ['暂无数据'],
        },
      });
    }

    const stages = this.buildSleepStages(records);
    const duration = this.calculateSleepDuration(stages);
    const observedMinutes = Math.max(
      1,
      Math.round(
        (records[records.length - 1].timestamp.getTime() -
          records[0].timestamp.getTime()) /
          60000,
      ),
    );
    const sleepMinutes = duration.total - duration.awake;
    const efficiency = Math.max(
      0,
      Math.min(100, Math.round((sleepMinutes / observedMinutes) * 100)),
    );
    const latency = this.calculateSleepLatency(stages);
    const awakenings = stages.filter((stage) => stage.state === 'awake').length;
    const sleepScore = this.calculateDailySleepScore({
      duration,
      efficiency,
      awakenings,
      latency,
    });
    const vitalSigns = this.aggregateVitalSigns(records);
    const healthSuggestions = this.generateHealthSuggestions({
      duration,
      efficiency,
      awakenings,
      latency,
      vitalSigns,
    });

    return this.prisma.sleepReport.create({
      data: {
        tenantId,
        deviceId,
        userId,
        reportDate,
        sleepScore,
        sleepDuration: duration,
        sleepEfficiency: efficiency,
        sleepLatency: latency,
        awakenings,
        sleepStructure: stages.map((stage) => ({
          state: stage.state,
          startTime: stage.startTime.getTime(),
          endTime: stage.endTime.getTime(),
          durationSeconds: stage.durationSeconds,
          confidence: stage.confidence,
        })),
        vitalSigns,
        healthSuggestions,
      },
    });
  }

  private toReportResponse(deviceId: string, reportDate: Date, report: any) {
    return {
      deviceId,
      date: this.formatDateOnly(reportDate),
      sleepScore: report.sleepScore ?? 0,
      sleepDuration: this.toClientSleepDuration(report.sleepDuration),
      sleepEfficiency: report.sleepEfficiency ?? 0,
      sleepLatency: report.sleepLatency ?? 0,
      awakenings: report.awakenings ?? 0,
      sleepStructure: Array.isArray(report.sleepStructure)
        ? report.sleepStructure
        : [],
      vitalSigns: this.normalizeVitalSigns(report.vitalSigns),
      healthSuggestions: Array.isArray(report.healthSuggestions)
        ? report.healthSuggestions
        : [],
    };
  }

  private toRealtimeResponse(deviceId: string, latestData: any) {
    if (!latestData) {
      return {
        deviceId,
        timestamp: Date.now(),
        heartRate: { value: 0, unit: 'bpm', status: 'unknown' },
        breathingRate: { value: 0, unit: 'times/min', status: 'unknown' },
        bodyMovement: { value: 0, unit: 'g', status: 'unknown' },
        sleepState: { state: 'unknown', confidence: 0 },
      };
    }

    return {
      deviceId,
      timestamp: latestData.timestamp.getTime(),
      heartRate: {
        value: latestData.heartRate ?? 0,
        unit: 'bpm',
        status: this.getVitalSignStatus(latestData.heartRate, 'heart_rate'),
      },
      breathingRate: {
        value: latestData.breathingRate ?? 0,
        unit: 'times/min',
        status: this.getVitalSignStatus(
          latestData.breathingRate,
          'breathing_rate',
        ),
      },
      bodyMovement: {
        value: Number(latestData.bodyMovement ?? 0),
        unit: 'g',
        status: this.getMovementStatus(Number(latestData.bodyMovement ?? 0)),
      },
      sleepState: {
        state: this.normalizeSleepState(latestData.sleepState),
        confidence: Number(latestData.confidence ?? 0),
      },
    };
  }

  private toRoutineRecordResponse(record: any) {
    return {
      id: record.id,
      date: this.formatDateOnly(record.date),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      stepsSnapshot: this.normalizeRoutineSteps(record.stepsSnapshot),
      finished: record.finished,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toDiaryResponse(diary: any) {
    return {
      id: diary.id,
      userId: diary.userId,
      deviceId: diary.deviceId,
      date: this.formatDateOnly(diary.date),
      bedTime: diary.bedTime,
      wakeTime: diary.wakeTime,
      fallAsleepMinutes: diary.fallAsleepMinutes,
      quality: diary.quality,
      summary: diary.summary,
      createdAt: diary.createdAt,
      updatedAt: diary.updatedAt,
    };
  }

  private toRelaxRecordResponse(record: any) {
    return {
      id: record.id,
      methodId: record.methodId,
      methodName: record.methodName,
      durationSeconds: record.durationSeconds,
      completedAt: record.completedAt,
      status: record.status,
      createdAt: record.createdAt,
    };
  }

  private async assertDeviceAccess(deviceId: string, userId: string) {
    const userDevice = await this.prisma.userDevice.findFirst({
      where: { deviceId, userId },
    });

    if (!userDevice) {
      throw new NotFoundException('Device not found or access denied');
    }
  }

  private requireTenantId(): string {
    const tenantId = TenantContext.getTenantId();
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required');
    }
    return tenantId;
  }

  private async requireDeviceTenant(deviceId: string): Promise<string> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId },
      select: { tenantId: true },
    });
    if (!device?.tenantId) {
      throw new BadRequestException(
        `Device ${deviceId} has no tenant assignment`,
      );
    }
    return device.tenantId;
  }

  private async assertOptionalDeviceAccess(
    deviceId: string | undefined,
    userId: string,
  ) {
    if (!deviceId) {
      return;
    }

    await this.assertDeviceAccess(deviceId, userId);
  }

  private toDateOnly(value?: string) {
    if (!value) {
      const now = new Date();
      return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      throw new BadRequestException('Invalid date value');
    }

    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  private formatDateOnly(date: Date) {
    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const day = `${date.getUTCDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private normalizeLimit(limit: number) {
    return Math.min(Math.max(limit || 20, 1), 100);
  }

  private sortRoutineSteps(steps: SleepRoutineStepDto[]) {
    return [...steps].sort((left, right) => left.sortOrder - right.sortOrder);
  }

  private normalizeRoutineSteps(steps: unknown) {
    if (!Array.isArray(steps)) {
      return this.defaultRoutineSteps;
    }

    return steps
      .map((step: any) => ({
        id: String(step.id),
        name: String(step.name),
        sortOrder: Number(step.sortOrder ?? 0),
        isFixed: Boolean(step.isFixed),
        enabled: Boolean(step.enabled),
      }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  private toJsonArray<T>(value: T[]): Prisma.InputJsonValue {
    return value as unknown as Prisma.InputJsonValue;
  }

  private normalizeSleepDuration(duration: unknown) {
    const source = (
      duration && typeof duration === 'object' ? duration : {}
    ) as Record<string, any>;

    return {
      total: Number(source.total ?? 0),
      deep: Number(source.deep ?? source.deepSleep ?? source.deep_sleep ?? 0),
      light: Number(
        source.light ?? source.lightSleep ?? source.light_sleep ?? 0,
      ),
      rem: Number(source.rem ?? source.remSleep ?? source.rem_sleep ?? 0),
      awake: Number(source.awake ?? 0),
    };
  }

  private toClientSleepDuration(duration: unknown) {
    const minutes = this.normalizeSleepDuration(duration);
    const toSeconds = (value: number) => Math.max(0, Math.round(value * 60));

    return {
      total: toSeconds(minutes.total),
      totalSeconds: toSeconds(minutes.total),
      total_seconds: toSeconds(minutes.total),
      totalMinutes: minutes.total,
      deep: toSeconds(minutes.deep),
      deepMinutes: minutes.deep,
      deepSleep: toSeconds(minutes.deep),
      deep_sleep: toSeconds(minutes.deep),
      light: toSeconds(minutes.light),
      lightMinutes: minutes.light,
      lightSleep: toSeconds(minutes.light),
      light_sleep: toSeconds(minutes.light),
      sound: toSeconds(minutes.deep),
      soundMinutes: minutes.deep,
      soundSleep: toSeconds(minutes.deep),
      sound_sleep: toSeconds(minutes.deep),
      rem: toSeconds(minutes.rem),
      remMinutes: minutes.rem,
      remSleep: toSeconds(minutes.rem),
      rem_sleep: toSeconds(minutes.rem),
      awake: toSeconds(minutes.awake),
      awakeMinutes: minutes.awake,
    };
  }

  private normalizeVitalSigns(vitalSigns: unknown) {
    const source = (
      vitalSigns && typeof vitalSigns === 'object' ? vitalSigns : {}
    ) as Record<string, any>;

    return {
      avgHeartRate: Number(source.avgHeartRate ?? 0),
      minHeartRate: Number(source.minHeartRate ?? 0),
      maxHeartRate: Number(source.maxHeartRate ?? 0),
      avgBreathingRate: Number(source.avgBreathingRate ?? 0),
      minBreathingRate: Number(source.minBreathingRate ?? 0),
      maxBreathingRate: Number(source.maxBreathingRate ?? 0),
    };
  }

  private aggregateHistory(records: any[], intervalSeconds: number) {
    if (records.length === 0) {
      return [];
    }

    const intervalMs = Math.max(intervalSeconds, 10) * 1000;
    const buckets = new Map<number, any[]>();

    for (const record of records) {
      const bucket =
        Math.floor(record.timestamp.getTime() / intervalMs) * intervalMs;
      const group = buckets.get(bucket) ?? [];
      group.push(record);
      buckets.set(bucket, group);
    }

    return Array.from(buckets.entries())
      .sort(([left], [right]) => left - right)
      .map(([timestamp, values]) => ({
        timestamp: new Date(timestamp),
        heartRate: this.averageNullable(values.map((item) => item.heartRate)),
        breathingRate: this.averageNullable(
          values.map((item) => item.breathingRate),
        ),
        bodyMovement: this.averageNullable(
          values.map((item) =>
            item.bodyMovement === null || item.bodyMovement === undefined
              ? null
              : Number(item.bodyMovement),
          ),
        ),
      }));
  }

  private averageNullable(values: Array<number | null | undefined>) {
    const validValues = values.filter(
      (value): value is number =>
        value !== null && value !== undefined && Number.isFinite(value),
    );

    if (validValues.length === 0) {
      return null;
    }

    const sum = validValues.reduce((total, value) => total + value, 0);
    return Math.round((sum / validValues.length) * 100) / 100;
  }

  private buildSleepStages(records: any[]): SleepStageResult[] {
    if (records.length === 0) {
      return [];
    }

    const stages: SleepStageResult[] = [];
    let currentState = this.detectSleepState(records[0]);
    let currentStart = records[0].timestamp;
    let currentRecords = [records[0]];

    for (let index = 1; index < records.length; index += 1) {
      const record = records[index];
      const detectedState = this.detectSleepState(record);

      if (detectedState === currentState) {
        currentRecords.push(record);
        continue;
      }

      stages.push(
        this.createStage(
          currentState,
          currentStart,
          record.timestamp,
          currentRecords,
        ),
      );
      currentState = detectedState;
      currentStart = record.timestamp;
      currentRecords = [record];
    }

    stages.push(
      this.createStage(
        currentState,
        currentStart,
        records[records.length - 1].timestamp,
        currentRecords,
      ),
    );

    return this.mergeShortStages(stages, 120);
  }

  private createStage(
    state: SleepState,
    startTime: Date,
    endTime: Date,
    records: any[],
  ): SleepStageResult {
    const durationSeconds = Math.max(
      60,
      Math.round((endTime.getTime() - startTime.getTime()) / 1000),
    );

    return {
      state,
      startTime,
      endTime,
      durationSeconds,
      confidence:
        this.averageNullable(records.map((record) => record.confidence)) ?? 0.5,
    };
  }

  private mergeShortStages(
    stages: SleepStageResult[],
    minDurationSeconds: number,
  ) {
    if (stages.length <= 1) {
      return stages;
    }

    const merged: SleepStageResult[] = [];
    for (const stage of stages) {
      if (stage.durationSeconds >= minDurationSeconds || merged.length === 0) {
        merged.push({ ...stage });
        continue;
      }

      const previous = merged[merged.length - 1];
      previous.endTime = stage.endTime;
      previous.durationSeconds += stage.durationSeconds;
      previous.confidence = Number(
        ((previous.confidence + stage.confidence) / 2).toFixed(2),
      );
    }

    return merged;
  }

  private detectSleepState(record: any): SleepState {
    const explicitState = this.normalizeSleepState(record.sleepState);
    if (explicitState !== 'unknown') {
      return explicitState;
    }

    const movement =
      record.bodyMovement === null || record.bodyMovement === undefined
        ? 0
        : Number(record.bodyMovement);
    const heartRate = record.heartRate ?? 70;
    const breathingRate = record.breathingRate ?? 16;

    if (movement > 0.5) {
      return 'awake';
    }

    if (movement < 0.1 && heartRate < 60 && breathingRate < 14) {
      return 'deep_sleep';
    }

    if (movement < 0.2 && heartRate >= 60 && heartRate <= 80) {
      return 'rem_sleep';
    }

    if (movement < 0.3 && heartRate < 75) {
      return 'light_sleep';
    }

    return 'unknown';
  }

  private calculateSleepDuration(stages: SleepStageResult[]) {
    const sumMinutes = (state: SleepState) =>
      Math.round(
        stages
          .filter((stage) => stage.state === state)
          .reduce((total, stage) => total + stage.durationSeconds, 0) / 60,
      );

    const deep = sumMinutes('deep_sleep');
    const light = sumMinutes('light_sleep');
    const rem = sumMinutes('rem_sleep');
    const awake = sumMinutes('awake');
    const unknown = sumMinutes('unknown');

    return {
      total: deep + light + rem + awake + unknown,
      deep,
      light: light + unknown,
      rem,
      awake,
    };
  }

  private calculateSleepLatency(stages: SleepStageResult[]) {
    const firstSleepStage = stages.find((stage) => stage.state !== 'awake');
    if (!firstSleepStage || stages.length === 0) {
      return 0;
    }

    return Math.max(
      0,
      Math.round(
        (firstSleepStage.startTime.getTime() - stages[0].startTime.getTime()) /
          60000,
      ),
    );
  }

  private aggregateVitalSigns(records: any[]) {
    const heartRates = records
      .map((record) => record.heartRate)
      .filter(
        (value: any): value is number => value !== null && value !== undefined,
      );
    const breathingRates = records
      .map((record) => record.breathingRate)
      .filter(
        (value: any): value is number => value !== null && value !== undefined,
      );

    return {
      avgHeartRate: this.roundAverage(heartRates),
      minHeartRate: heartRates.length > 0 ? Math.min(...heartRates) : 0,
      maxHeartRate: heartRates.length > 0 ? Math.max(...heartRates) : 0,
      avgBreathingRate: this.roundAverage(breathingRates),
      minBreathingRate:
        breathingRates.length > 0 ? Math.min(...breathingRates) : 0,
      maxBreathingRate:
        breathingRates.length > 0 ? Math.max(...breathingRates) : 0,
    };
  }

  private roundAverage(values: number[]) {
    if (values.length === 0) {
      return 0;
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    return Math.round((total / values.length) * 100) / 100;
  }

  private calculateDailySleepScore(params: {
    duration: {
      total: number;
      deep: number;
      light: number;
      rem: number;
      awake: number;
    };
    efficiency: number;
    awakenings: number;
    latency: number;
  }) {
    const totalSleepMinutes = params.duration.total - params.duration.awake;
    let score = 45;

    if (totalSleepMinutes >= 420 && totalSleepMinutes <= 540) {
      score += 20;
    } else if (totalSleepMinutes >= 360) {
      score += 12;
    }

    if (params.duration.total > 0) {
      const deepRatio = params.duration.deep / Math.max(totalSleepMinutes, 1);
      const remRatio = params.duration.rem / Math.max(totalSleepMinutes, 1);

      if (deepRatio >= 0.15 && deepRatio <= 0.25) {
        score += 10;
      }
      if (remRatio >= 0.18 && remRatio <= 0.28) {
        score += 10;
      }
    }

    score += Math.round(params.efficiency / 10);
    score -= Math.min(params.awakenings * 2, 10);
    score -= Math.min(Math.floor(params.latency / 10), 10);

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private generateHealthSuggestions(params: {
    duration: {
      total: number;
      deep: number;
      light: number;
      rem: number;
      awake: number;
    };
    efficiency: number;
    awakenings: number;
    latency: number;
    vitalSigns: {
      avgHeartRate: number;
      minHeartRate: number;
      maxHeartRate: number;
      avgBreathingRate: number;
      minBreathingRate: number;
      maxBreathingRate: number;
    };
  }) {
    const suggestions: string[] = [];
    const totalSleepMinutes = params.duration.total - params.duration.awake;

    if (totalSleepMinutes < 360) {
      suggestions.push('睡眠时长偏短，建议适当提前入睡时间。');
    }

    if (params.efficiency < 75) {
      suggestions.push(
        '睡眠效率偏低，建议减少睡前使用电子设备并保持卧室安静。',
      );
    }

    if (params.latency > 30) {
      suggestions.push('入睡时间偏长，可以尝试呼吸训练或冥想放松。');
    }

    if (params.awakenings > 3) {
      suggestions.push('夜间觉醒次数较多，建议检查温度、噪音和光线环境。');
    }

    if (params.vitalSigns.avgHeartRate > 80) {
      suggestions.push(
        '睡眠期间平均心率偏高，建议关注近期压力和运动恢复情况。',
      );
    }

    if (params.vitalSigns.avgBreathingRate > 20) {
      suggestions.push(
        '睡眠期间平均呼吸频率偏高，建议留意鼻塞或睡眠呼吸问题。',
      );
    }

    if (suggestions.length === 0) {
      suggestions.push('本次睡眠整体平稳，请继续保持规律作息。');
    }

    return suggestions;
  }

  private async getOrCreateDailyReport(
    deviceId: string,
    userId: string,
    reportDate: Date,
  ) {
    const existingReport = await this.prisma.sleepReport.findFirst({
      where: { deviceId, reportDate },
      orderBy: { createdAt: 'desc' },
    });

    if (existingReport) {
      return existingReport;
    }

    const startOfDay = new Date(reportDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(reportDate);
    endOfDay.setHours(23, 59, 59, 999);

    const hasRecords = await this.prisma.vitalSignsData.findFirst({
      where: {
        deviceId,
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: { id: true },
    });

    if (!hasRecords) {
      return null;
    }

    return this.generateDailyReport(deviceId, userId, reportDate);
  }

  private listDateRange(startDate: Date, endDate: Date) {
    const dates: Date[] = [];
    const cursor = new Date(startDate);

    while (cursor <= endDate) {
      dates.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
  }

  private parseTrendMetrics(metricValue?: string) {
    const rawMetrics =
      metricValue
        ?.split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean) ?? [];

    if (rawMetrics.length === 0) {
      return new Set(['sleep_score', 'sleep_duration', 'efficiency']);
    }

    const metrics = new Set<string>();
    for (const metric of rawMetrics) {
      if (metric === 'sleep_score' || metric === 'score') {
        metrics.add('sleep_score');
      }
      if (metric === 'sleep_duration' || metric === 'duration') {
        metrics.add('sleep_duration');
      }
      if (metric === 'efficiency' || metric === 'sleep_efficiency') {
        metrics.add('efficiency');
      }
    }

    return metrics.size > 0
      ? metrics
      : new Set(['sleep_score', 'sleep_duration', 'efficiency']);
  }

  private normalizeSleepState(value: unknown): SleepState {
    if (
      value === 'awake' ||
      value === 'light_sleep' ||
      value === 'deep_sleep' ||
      value === 'rem_sleep'
    ) {
      return value;
    }

    return 'unknown';
  }

  private normalizeHeartRate(value?: number) {
    if (value === undefined || value === null) {
      return null;
    }

    if (value < 30 || value > 220) {
      return null;
    }

    return Math.round(value);
  }

  private normalizeBreathingRate(value?: number) {
    if (value === undefined || value === null) {
      return null;
    }

    if (value < 6 || value > 40) {
      return null;
    }

    return Math.round(value);
  }

  private calculateInstantSleepScore(data: {
    heartRate: number | null;
    breathingRate: number | null;
    bodyMovement: number | null;
    sleepState: SleepState;
  }) {
    let score = 50;

    if (data.sleepState === 'deep_sleep') score += 25;
    if (data.sleepState === 'rem_sleep') score += 15;
    if (data.sleepState === 'light_sleep') score += 8;
    if (data.sleepState === 'awake') score -= 20;

    if (data.heartRate !== null) {
      if (data.heartRate >= 50 && data.heartRate <= 70) score += 10;
      if (data.heartRate > 90) score -= 10;
    }

    if (data.bodyMovement !== null) {
      if (data.bodyMovement < 0.1) score += 8;
      if (data.bodyMovement > 0.5) score -= 8;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private calculateConfidence(data: {
    heartRate: number | null;
    breathingRate: number | null;
    bodyMovement: number | null;
    sleepState: SleepState;
  }) {
    let confidence = 0.4;

    if (data.heartRate !== null) confidence += 0.2;
    if (data.breathingRate !== null) confidence += 0.2;
    if (data.bodyMovement !== null) confidence += 0.15;
    if (data.sleepState !== 'unknown') confidence += 0.05;

    return Math.min(1, Number(confidence.toFixed(2)));
  }

  private async safeRedisGet(key: string) {
    try {
      return await this.redisService.get(key);
    } catch (error) {
      this.logger.warn(
        `Redis read failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async safeRedisSet(key: string, value: string, ttl?: number) {
    try {
      await this.redisService.set(key, value, ttl);
    } catch (error) {
      this.logger.warn(
        `Redis write failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getVitalSignStatus(
    value: number | null | undefined,
    type: 'heart_rate' | 'breathing_rate',
  ) {
    if (value === null || value === undefined || value <= 0) {
      return 'unknown';
    }

    if (type === 'heart_rate') {
      if (value < 50) return 'low';
      if (value > 120) return 'high';
      return 'normal';
    }

    if (value < 10) return 'low';
    if (value > 25) return 'high';
    return 'normal';
  }

  private getMovementStatus(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return 'unknown';
    }

    if (value < 0.1) return 'low';
    if (value < 0.5) return 'normal';
    return 'high';
  }
}
