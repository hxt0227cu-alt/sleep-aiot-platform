import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AssistantToolCall,
  AssistantToolName,
  KnowledgeAnswerSource,
} from './assistant.types';

@Injectable()
export class ResponseGuardService {
  validateSleepExplanation(rawContent: string) {
    const parsed = this.parseJsonObject(rawContent);

    return {
      answer: this.ensureString(parsed.answer, 'answer'),
      keyFindings: this.ensureStringArray(parsed.keyFindings),
      recommendations: this.ensureStringArray(parsed.recommendations),
      caution: this.ensureOptionalString(parsed.caution),
    };
  }

  validateKnowledgeAnswer(
    rawContent: string,
    fallbackSources: KnowledgeAnswerSource[],
    groundedAnswer: string,
  ) {
    const parsed = this.parseJsonObject(rawContent);
    this.ensureString(parsed.answer, 'answer');

    return {
      answer: groundedAnswer,
      sources: fallbackSources,
      matchedTopics: this.ensureStringArray(parsed.matchedTopics),
    };
  }

  validateToolCall(toolCall: AssistantToolCall): AssistantToolCall {
    const allowedNames: AssistantToolName[] = [
      'set_sleep_mode',
      'light_control',
      'audio_control',
    ];

    if (!allowedNames.includes(toolCall.name)) {
      throw new BadRequestException(`Unsupported tool name: ${toolCall.name}`);
    }

    if (!toolCall.arguments || typeof toolCall.arguments !== 'object') {
      throw new BadRequestException('Tool arguments must be an object');
    }

    return toolCall;
  }

  private parseJsonObject(rawContent: string): Record<string, any> {
    const normalized = rawContent
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      const parsed: unknown = JSON.parse(normalized);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON root must be an object');
      }
      return parsed as Record<string, any>;
    } catch {
      throw new BadRequestException('LLM returned invalid JSON');
    }
  }

  private ensureString(value: unknown, field: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(
        `Field ${field} must be a non-empty string`,
      );
    }

    return value.trim();
  }

  private ensureOptionalString(value: unknown) {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Field caution must be a string');
    }

    return value.trim();
  }

  private ensureStringArray(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
