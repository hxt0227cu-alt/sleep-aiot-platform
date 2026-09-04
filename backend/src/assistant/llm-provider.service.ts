import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AssistantToolCall, AssistantToolName } from './assistant.types';
import { MetricsService } from '../observability/metrics.service';

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private client: OpenAI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async generateStructuredJson(params: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
  }): Promise<string> {
    const client = this.getClient();
    const model = this.getChatModel();
    const completion = await this.observe('structured_json', model, () =>
      client.chat.completions.create({
        model,
        temperature: params.temperature ?? 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
      }),
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new ServiceUnavailableException('LLM returned an empty response');
    }

    return content;
  }

  async planDeviceControl(params: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<AssistantToolCall> {
    const client = this.getClient();
    const model = this.getChatModel();
    const completion = await this.observe('tool_planning', model, () =>
      client.chat.completions.create({
        model,
        temperature: 0,
        tool_choice: 'required',
        tools: [
          {
            type: 'function',
            function: {
              name: 'set_sleep_mode',
              description:
                'Set a gentle sleep light mode and optionally play a sound.',
              parameters: {
                type: 'object',
                properties: {
                  brightness: { type: 'number' },
                  color_temp: { type: 'number' },
                  sound: { type: 'string' },
                  volume: { type: 'number' },
                  duration_minutes: { type: 'number' },
                },
                required: ['brightness'],
                additionalProperties: false,
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'light_control',
              description:
                'Control the lamp power, brightness, color temperature, or light scene.',
              parameters: {
                type: 'object',
                properties: {
                  power: { type: 'boolean' },
                  brightness: { type: 'number' },
                  brightness_delta: { type: 'number' },
                  color_temp: { type: 'number' },
                  color_temp_delta: { type: 'number' },
                  scene: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'audio_control',
              description: 'Play or stop white noise and adjust volume.',
              parameters: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['play', 'stop'] },
                  sound: { type: 'string' },
                  volume: { type: 'number' },
                },
                required: ['action'],
                additionalProperties: false,
              },
            },
          },
        ],
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
      }),
    );

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') {
      throw new ServiceUnavailableException(
        'LLM did not return a function call',
      );
    }

    let parsedArguments: Record<string, any> = {};
    try {
      parsedArguments = JSON.parse(toolCall.function.arguments || '{}');
    } catch (error) {
      this.logger.error('Failed to parse function arguments', error as Error);
      throw new ServiceUnavailableException(
        'LLM returned invalid function arguments',
      );
    }

    return {
      name: toolCall.function.name as AssistantToolName,
      arguments: parsedArguments,
      rawToolCallId: toolCall.id,
    };
  }

  async embedText(input: string): Promise<number[]> {
    const client = this.getClient();
    const model = this.getEmbeddingModel();
    const response = await this.observe('embedding', model, () =>
      client.embeddings.create({
        model,
        input,
      }),
    );

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new ServiceUnavailableException(
        'Embedding request returned no vector',
      );
    }

    return embedding;
  }

  private getClient() {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const baseURL = this.configService.get<string>('OPENAI_BASE_URL');
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not configured');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });
    return this.client;
  }

  private getChatModel() {
    return this.configService.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o-mini';
  }

  private getEmbeddingModel() {
    return (
      this.configService.get<string>('OPENAI_EMBEDDING_MODEL') ||
      'text-embedding-3-small'
    );
  }

  private async observe<T>(
    operation: string,
    model: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const end = this.metrics.llmDuration.startTimer();
    let outcome = 'success';
    try {
      return await action();
    } catch (error) {
      outcome = 'failure';
      throw error;
    } finally {
      this.metrics.llmRequests.inc({ operation, model, outcome });
      end({ operation, model, outcome });
    }
  }
}
