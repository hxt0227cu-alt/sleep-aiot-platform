import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { DeviceService } from '../device/device.service';
import { SleepService } from '../sleep/sleep.service';
import { DeviceControlDto } from './dto/device-control.dto';
import { ExplainSleepReportDto } from './dto/explain-sleep-report.dto';
import { KnowledgeAskDto } from './dto/knowledge-ask.dto';
import { DeviceControlMapperService } from './device-control-mapper.service';
import { LlmProviderService } from './llm-provider.service';
import { PromptBuilderService } from './prompt-builder.service';
import { ResponseGuardService } from './response-guard.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sleepService: SleepService,
    private readonly deviceService: DeviceService,
    private readonly llmProvider: LlmProviderService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly responseGuard: ResponseGuardService,
    private readonly deviceControlMapper: DeviceControlMapperService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  async explainSleepReport(userId: string, dto: ExplainSleepReportDto) {
    return this.getSleepReportExplanation(userId, dto, true);
  }

  async getSleepReportExplanation(
    userId: string,
    dto: ExplainSleepReportDto,
    preferLlm = true,
  ) {
    const report = await this.sleepService.getReport(dto.deviceId, userId, {
      date: dto.date,
    });

    let parsed: {
      answer: string;
      keyFindings: string[];
      recommendations: string[];
      caution: string;
    };

    if (preferLlm) {
      try {
        const prompts = this.promptBuilder.buildSleepReportExplanationPrompts(
          dto.question,
          report,
        );
        const rawContent =
          await this.llmProvider.generateStructuredJson(prompts);
        parsed = this.responseGuard.validateSleepExplanation(rawContent);
      } catch (error) {
        this.logger.warn(
          'LLM sleep explanation failed, falling back to deterministic summary',
        );
        parsed = this.buildFallbackSleepExplanation(dto.question, report);
      }
    } else {
      parsed = this.buildFallbackSleepExplanation(dto.question, report);
    }

    return {
      deviceId: dto.deviceId,
      reportDate: report.date,
      question: dto.question,
      ...parsed,
    };
  }

  async controlDevice(userId: string, dto: DeviceControlDto) {
    const prompts = this.promptBuilder.buildDeviceControlPrompts(dto.text);
    const toolCall = this.responseGuard.validateToolCall(
      await this.llmProvider.planDeviceControl(prompts),
    );
    const requestId = toolCall.rawToolCallId || `assistant_${Date.now()}`;
    const executionPlan = this.deviceControlMapper.mapToolCall(toolCall);

    const immediateResults = [];
    for (const command of executionPlan.immediateCommands) {
      const result = await this.deviceService.sendCommand(
        dto.deviceId,
        userId,
        {
          command: command.command as any,
          params: command.params,
          timeout: command.timeout,
        },
      );

      immediateResults.push({
        command: command.command,
        params: command.params,
        summary: command.summary,
        result,
      });
    }

    const scheduledActions = [];
    for (const action of executionPlan.scheduledActions) {
      const created = await this.prisma.scheduledDeviceAction.create({
        data: {
          deviceId: dto.deviceId,
          userId,
          actionType: action.actionType,
          command: action.command,
          params: action.params,
          executeAt: action.executeAt,
          relatedRequestId: requestId,
        },
      });

      scheduledActions.push({
        id: created.id,
        actionType: created.actionType,
        command: created.command,
        params: created.params,
        executeAt: created.executeAt.getTime(),
        status: created.status,
        summary: action.summary,
      });
    }

    return {
      requestId,
      deviceId: dto.deviceId,
      text: dto.text,
      source: dto.source || 'text',
      toolCall: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
      summary: executionPlan.summary,
      immediateResults,
      scheduledActions,
    };
  }

  async askKnowledge(_userId: string, dto: KnowledgeAskDto) {
    return this.knowledgeService.answerQuestion(dto.question, dto.deviceId);
  }

  private buildFallbackSleepExplanation(
    question: string,
    report: Record<string, any>,
  ) {
    const sleepScore = Number(report.sleepScore || 0);
    const sleepEfficiency = Number(report.sleepEfficiency || 0);
    const sleepLatency = Number(report.sleepLatency || 0);
    const awakenings = Number(report.awakenings || 0);
    const durationText = this.formatSleepDuration(report.sleepDuration);
    const keyFindings = [
      `睡眠评分 ${sleepScore} 分`,
      `总睡眠时长 ${durationText}`,
      `睡眠效率 ${sleepEfficiency}%`,
      `夜间醒来 ${awakenings} 次`,
    ];

    if (sleepLatency > 0) {
      keyFindings.push(`入睡耗时约 ${sleepLatency} 分钟`);
    }

    const recommendations =
      Array.isArray(report.healthSuggestions) &&
      report.healthSuggestions.length > 0
        ? report.healthSuggestions.filter((item) => typeof item === 'string')
        : this.buildFallbackRecommendations(
            sleepScore,
            sleepEfficiency,
            awakenings,
            sleepLatency,
          );

    const caution =
      sleepScore < 60 || sleepEfficiency < 75
        ? '昨晚睡眠质量偏弱，建议继续观察最近 3 到 7 天的趋势。'
        : awakenings >= 4
          ? '夜间觉醒次数偏多，建议结合卧室噪声、光线和作息节律继续观察。'
          : '';

    return {
      answer: `${question} 根据 ${report.date} 的睡眠数据，你昨晚的睡眠评分为 ${sleepScore} 分，总睡眠时长约 ${durationText}，睡眠效率 ${sleepEfficiency}%，夜间醒来 ${awakenings} 次。${caution || '整体表现可以继续保持。'}`,
      keyFindings,
      recommendations,
      caution,
    };
  }

  private buildFallbackRecommendations(
    sleepScore: number,
    sleepEfficiency: number,
    awakenings: number,
    sleepLatency: number,
  ) {
    const recommendations: string[] = [];

    if (sleepLatency > 30) {
      recommendations.push('建议睡前 30 分钟降低灯光亮度，减少屏幕刺激。');
    }
    if (awakenings >= 3) {
      recommendations.push('夜间醒来较多，建议检查卧室温度、噪声和床垫支撑。');
    }
    if (sleepEfficiency < 80) {
      recommendations.push(
        '建议固定入睡和起床时间，连续观察一周睡眠效率变化。',
      );
    }
    if (sleepScore >= 80 && recommendations.length === 0) {
      recommendations.push('整体状态不错，继续保持规律作息和稳定的睡前流程。');
    }
    if (recommendations.length === 0) {
      recommendations.push('建议结合近一周趋势继续观察睡眠评分和觉醒次数。');
    }

    return recommendations;
  }

  private formatSleepDuration(duration: any) {
    if (!duration || typeof duration !== 'object') {
      return '0 小时 0 分钟';
    }

    const totalMinutes = Number(
      duration.totalMinutes ?? duration.total_minutes ?? duration.total ?? 0,
    );
    const hours =
      totalMinutes > 0
        ? Math.floor(totalMinutes / 60)
        : Number(duration.hours || 0);
    const minutes =
      totalMinutes > 0 ? totalMinutes % 60 : Number(duration.minutes || 0);

    return `${hours} 小时 ${minutes} 分钟`;
  }
}
