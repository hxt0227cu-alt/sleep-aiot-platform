import { Injectable } from '@nestjs/common';
import {
  AssistantDeviceExecutionPlan,
  AssistantImmediateCommand,
  AssistantScheduledActionPlan,
  AssistantToolCall,
} from './assistant.types';

const MIN_BRIGHTNESS = 0;
const MAX_BRIGHTNESS = 100;
const MIN_COLOR_TEMP = 2700;
const MAX_COLOR_TEMP = 6500;
const DEFAULT_SLEEP_BRIGHTNESS = 25;
const DEFAULT_SLEEP_COLOR_TEMP = 2700;
const DEFAULT_VOLUME = 70;

@Injectable()
export class DeviceControlMapperService {
  mapToolCall(
    toolCall: AssistantToolCall,
    requestedAt = new Date(),
  ): AssistantDeviceExecutionPlan {
    switch (toolCall.name) {
      case 'set_sleep_mode':
        return this.mapSleepMode(toolCall, requestedAt);
      case 'light_control':
        return this.mapLightControl(toolCall);
      case 'audio_control':
        return this.mapAudioControl(toolCall);
      default:
        return {
          toolCall,
          immediateCommands: [],
          scheduledActions: [],
          summary: [],
        };
    }
  }

  private mapSleepMode(
    toolCall: AssistantToolCall,
    requestedAt: Date,
  ): AssistantDeviceExecutionPlan {
    const args = toolCall.arguments;
    const brightness = this.clamp(
      args.brightness,
      DEFAULT_SLEEP_BRIGHTNESS,
      100,
    );
    const colorTemp = this.clampColorTemp(
      args.color_temp ?? args.colorTemp ?? DEFAULT_SLEEP_COLOR_TEMP,
    );
    const sound = this.normalizeSound(args.sound);
    const volume = this.clamp(args.volume, DEFAULT_VOLUME, 100);
    const durationMinutes = this.normalizeDuration(args.duration_minutes);

    const immediateCommands: AssistantImmediateCommand[] = [
      {
        command: 'light_control',
        params: {
          power: true,
          scene: 'sleep',
          brightness,
          color_temp: colorTemp,
          source: 'assistant',
        },
        timeout: 8000,
        summary: `助眠灯已调整为 ${brightness}% 亮度、${colorTemp}K 色温`,
      },
    ];

    const summary = [`设置助眠灯为 ${brightness}% 亮度，色温 ${colorTemp}K`];

    if (sound) {
      immediateCommands.push({
        command: 'audio_control',
        params: {
          action: 'play',
          sound,
          volume,
          source: 'assistant',
        },
        timeout: 8000,
        summary: `开始播放 ${sound}，音量 ${volume}%`,
      });
      summary.push(`播放 ${sound}，音量 ${volume}%`);
    }

    const scheduledActions: AssistantScheduledActionPlan[] = [];
    if (durationMinutes !== null) {
      const executeAt = new Date(
        requestedAt.getTime() + durationMinutes * 60 * 1000,
      );
      scheduledActions.push({
        actionType: 'light_shutdown',
        command: 'light_control',
        params: {
          power: false,
          source: 'assistant_schedule',
        },
        delayMinutes: durationMinutes,
        executeAt,
        summary: `${durationMinutes} 分钟后关闭灯光`,
      });

      if (sound) {
        scheduledActions.push({
          actionType: 'audio_shutdown',
          command: 'audio_control',
          params: {
            action: 'stop',
            source: 'assistant_schedule',
          },
          delayMinutes: durationMinutes,
          executeAt,
          summary: `${durationMinutes} 分钟后停止白噪音`,
        });
      }
      summary.push(`${durationMinutes} 分钟后关闭相关设备`);
    }

    return { toolCall, immediateCommands, scheduledActions, summary };
  }

  private mapLightControl(
    toolCall: AssistantToolCall,
  ): AssistantDeviceExecutionPlan {
    const args = { ...toolCall.arguments };

    if ((args.scene || '').toString().toLowerCase() === 'sleep') {
      args.power = args.power ?? true;
      args.brightness = args.brightness ?? DEFAULT_SLEEP_BRIGHTNESS;
      args.color_temp = args.color_temp ?? DEFAULT_SLEEP_COLOR_TEMP;
    }

    if (
      args.power === undefined &&
      (args.brightness !== undefined ||
        args.brightness_delta !== undefined ||
        args.color_temp !== undefined ||
        args.color_temp_delta !== undefined)
    ) {
      args.power = true;
    }

    if (args.brightness !== undefined) {
      args.brightness = this.clamp(
        args.brightness,
        DEFAULT_SLEEP_BRIGHTNESS,
        100,
      );
    }
    if (args.brightness_delta !== undefined) {
      args.brightness_delta = this.clamp(args.brightness_delta, 0, 100, true);
    }
    if (args.color_temp !== undefined) {
      args.color_temp = this.clampColorTemp(args.color_temp);
    }
    if (args.color_temp_delta !== undefined) {
      args.color_temp_delta = this.clamp(args.color_temp_delta, 0, 3000, true);
    }
    args.source = 'assistant';

    const summary = ['执行灯光控制'];
    if (typeof args.power === 'boolean') {
      summary.push(args.power ? '打开灯光' : '关闭灯光');
    }
    if (typeof args.brightness === 'number') {
      summary.push(`亮度 ${args.brightness}%`);
    }
    if (typeof args.brightness_delta === 'number') {
      summary.push(
        args.brightness_delta > 0
          ? `亮度提高 ${args.brightness_delta}`
          : `亮度降低 ${Math.abs(args.brightness_delta)}`,
      );
    }
    if (typeof args.color_temp === 'number') {
      summary.push(`色温 ${args.color_temp}K`);
    }
    if (typeof args.color_temp_delta === 'number') {
      summary.push(
        args.color_temp_delta > 0
          ? `色温提高 ${args.color_temp_delta}`
          : `色温降低 ${Math.abs(args.color_temp_delta)}`,
      );
    }
    if (typeof args.scene === 'string' && args.scene) {
      summary.push(`场景 ${args.scene}`);
    }

    return {
      toolCall,
      immediateCommands: [
        {
          command: 'light_control',
          params: args,
          timeout: 8000,
          summary: summary.join('，'),
        },
      ],
      scheduledActions: [],
      summary,
    };
  }

  private mapAudioControl(
    toolCall: AssistantToolCall,
  ): AssistantDeviceExecutionPlan {
    const args = { ...toolCall.arguments };
    args.action =
      String(args.action || 'play').toLowerCase() === 'stop' ? 'stop' : 'play';
    args.source = 'assistant';

    if (args.action === 'play') {
      args.sound = this.normalizeSound(args.sound);
      args.volume = this.clamp(args.volume, DEFAULT_VOLUME, 100);
    } else {
      delete args.sound;
      delete args.volume;
    }

    const summary =
      args.action === 'stop'
        ? ['停止白噪音']
        : [`播放 ${args.sound}`, `音量 ${args.volume}%`];

    return {
      toolCall,
      immediateCommands: [
        {
          command: 'audio_control',
          params: args,
          timeout: 8000,
          summary: summary.join('，'),
        },
      ],
      scheduledActions: [],
      summary,
    };
  }

  private normalizeDuration(value: unknown) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return null;
    }

    return Math.min(Math.round(numericValue), 720);
  }

  private normalizeSound(value: unknown) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    const mapping: Record<string, string> = {
      rain: 'rain',
      white_noise: 'rain',
      whitenoise: 'rain',
      ocean: 'wind',
      sea: 'wind',
      forest: 'bird',
      wind: 'wind',
      thunder: 'thunder',
      lightning: 'wind',
      bird: 'bird',
    };

    if (!normalized) {
      return null;
    }

    return mapping[normalized] || 'rain';
  }

  private clamp(
    value: unknown,
    defaultValue: number,
    max: number,
    allowNegative = false,
  ) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return defaultValue;
    }

    if (allowNegative) {
      return Math.max(-max, Math.min(max, Math.round(numericValue)));
    }

    return Math.max(MIN_BRIGHTNESS, Math.min(max, Math.round(numericValue)));
  }

  private clampColorTemp(value: unknown) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return DEFAULT_SLEEP_COLOR_TEMP;
    }

    return Math.max(
      MIN_COLOR_TEMP,
      Math.min(MAX_COLOR_TEMP, Math.round(numericValue)),
    );
  }
}
