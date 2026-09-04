import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MqttService } from '../mqtt/mqtt.service';
import { AssistantService } from './assistant.service';

@Injectable()
export class VoiceQueryMqttService implements OnModuleInit {
  private readonly logger = new Logger(VoiceQueryMqttService.name);

  constructor(
    private readonly mqttService: MqttService,
    private readonly prisma: PrismaService,
    private readonly assistantService: AssistantService,
  ) {}

  onModuleInit() {
    this.mqttService.registerOwnedTopicCallback(
      'device/+/voice/query',
      (topic, message) => {
        void this.handleMessage(topic, message.toString());
      },
    );
    this.logger.log('Subscribed to device/+/voice/query');
  }

  private async handleMessage(topic: string, rawPayload: string) {
    const deviceId = this.extractDeviceId(topic);
    if (!deviceId) {
      return;
    }

    let payload: any = {};
    try {
      payload = JSON.parse(rawPayload || '{}');
    } catch {
      await this.publishError(deviceId, '', 'invalid_json');
      return;
    }

    const data =
      payload?.data && typeof payload.data === 'object'
        ? payload.data
        : payload;
    const queryId = this.asString(data?.queryId || payload?.messageId);
    const query = this.asString(data?.query) || '我昨天晚上睡得怎么样？';
    const queryType =
      this.asString(data?.queryType || data?.query_type) || 'sleep_report';
    const reportDate = this.resolveReportDate(
      this.asString(data?.reportDate || data?.report_date),
      query,
    );

    if (queryType !== 'sleep_report') {
      await this.publishError(
        deviceId,
        queryId,
        'unsupported_query_type',
        query,
        reportDate,
      );
      return;
    }

    const owner = await this.prisma.userDevice.findFirst({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
    });
    if (!owner) {
      await this.publishError(
        deviceId,
        queryId,
        'device_not_bound',
        query,
        reportDate,
      );
      return;
    }

    try {
      const explanation = await this.assistantService.getSleepReportExplanation(
        owner.userId,
        {
          deviceId,
          date: reportDate,
          question: query,
        },
        false,
      );

      await this.publishResponse(deviceId, {
        queryId,
        status: 'success',
        query,
        queryType,
        reportDate: explanation.reportDate,
        answer: explanation.answer,
        keyFindings: explanation.keyFindings,
        recommendations: explanation.recommendations,
        caution: explanation.caution,
      });
    } catch (error) {
      this.logger.error(
        `Failed to answer voice query for ${deviceId}`,
        error as Error,
      );
      await this.publishError(
        deviceId,
        queryId,
        'sleep_report_failed',
        query,
        reportDate,
      );
    }
  }

  private async publishResponse(deviceId: string, data: Record<string, any>) {
    await this.mqttService.publish(
      `device/${deviceId}/voice/response`,
      JSON.stringify({
        messageId: `voice_rsp_${Date.now()}`,
        timestamp: Date.now(),
        deviceId,
        type: 'voice/response',
        data,
      }),
      { qos: 1 },
    );
  }

  private async publishError(
    deviceId: string,
    queryId: string,
    error: string,
    query = '',
    reportDate = '',
  ) {
    await this.publishResponse(deviceId, {
      queryId,
      status: 'error',
      error,
      query,
      reportDate,
      answer: '',
      keyFindings: [],
      recommendations: [],
      caution: error,
    });
  }

  private extractDeviceId(topic: string) {
    const matched = /^device\/([^/]+)\/voice\/query$/.exec(topic);
    return matched?.[1] || '';
  }

  private asString(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
  }

  private resolveReportDate(rawDate: string, query: string) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return rawDate;
    }

    const now = new Date();
    if (
      rawDate === 'yesterday' ||
      query.includes('昨天') ||
      query.includes('昨晚') ||
      query.includes('昨天晚上')
    ) {
      now.setDate(now.getDate() - 1);
    }

    const year = now.getFullYear();
    const month = `${now.getMonth() + 1}`.padStart(2, '0');
    const day = `${now.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
