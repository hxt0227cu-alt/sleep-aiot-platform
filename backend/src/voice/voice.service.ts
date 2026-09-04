import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecognizeDto } from './dto/recognize.dto';
import { TtsDto } from './dto/tts.dto';

type WhiteNoiseItem = {
  id: string;
  name: string;
  category: string;
  duration: number;
  url: string;
  cover: string;
  mappedDeviceSound: string;
};

@Injectable()
export class VoiceService {
  private readonly recognitionHistory: Array<Record<string, unknown>> = [];
  private readonly ttsHistory: Array<Record<string, unknown>> = [];

  constructor(private readonly configService: ConfigService) {}

  async getWhiteNoiseList() {
    return {
      sounds: this.getWhiteNoiseCatalog(),
    };
  }

  async recognize(recognizeDto: RecognizeDto, userId?: string) {
    const {
      deviceId,
      audioData,
      audioUrl,
      recognitionMode = 'cloud',
    } = recognizeDto;
    const audioPayload = audioData || audioUrl;

    if (recognitionMode === 'cloud') {
      return await this.cloudRecognize(deviceId, audioPayload, userId);
    }
    throw new NotFoundException(
      'Local recognition is not available; use cloud recognition',
    );
  }

  async textToSpeech(ttsDto: TtsDto, userId?: string) {
    const { text, voice = 'female', speed = 1.0 } = ttsDto;
    const appId = this.configService.get<string>('BAIDU_TTS_APP_ID');
    const apiKey = this.configService.get<string>('BAIDU_TTS_API_KEY');
    const secretKey = this.configService.get<string>('BAIDU_TTS_SECRET_KEY');

    if (!appId || !apiKey || !secretKey) {
      throw new NotFoundException('Baidu TTS configuration missing');
    }

    try {
      const accessToken = await this.getBaiduAccessToken(apiKey, secretKey);
      const audioUrl = await this.callBaiduTTS(accessToken, text, voice, speed);

      const result = {
        audioUrl,
        duration: this.estimateDuration(text, speed),
      };
      this.record(this.ttsHistory, { userId, text, voice, speed, ...result });
      return result;
    } catch (error) {
      throw new NotFoundException('Text to speech failed');
    }
  }

  async playWhiteNoise(
    deviceId: string,
    noiseType: string,
    volume = 0.5,
    duration = 1800,
  ) {
    const sound = this.getWhiteNoiseCatalog().find(
      (item) => item.id === noiseType || item.id === `${noiseType}_noise`,
    );

    if (!sound) {
      throw new NotFoundException(`Unsupported white noise: ${noiseType}`);
    }

    return {
      deviceId,
      command: 'audio_control',
      params: {
        action: 'play',
        sound: sound.mappedDeviceSound,
        volume: Math.round(volume * 100),
      },
      noiseType,
      mappedDeviceSound: sound.mappedDeviceSound,
      volume,
      duration,
      url: sound.url,
      status: 'queued',
      timestamp: Date.now(),
    };
  }

  async stopWhiteNoise(deviceId: string) {
    return {
      deviceId,
      command: 'audio_control',
      params: {
        action: 'stop',
      },
      status: 'queued',
      timestamp: Date.now(),
    };
  }

  async getRecognitionHistory(userId: string) {
    return {
      userId,
      records: this.recognitionHistory.filter(
        (record) => record.userId === userId,
      ),
      total: this.recognitionHistory.filter(
        (record) => record.userId === userId,
      ).length,
    };
  }

  async getTtsHistory(userId: string) {
    return {
      userId,
      records: this.ttsHistory.filter((record) => record.userId === userId),
      total: this.ttsHistory.filter((record) => record.userId === userId)
        .length,
    };
  }

  private getWhiteNoiseCatalog(): WhiteNoiseItem[] {
    const cdnBaseUrl = this.configService.get('CDN_BASE_URL') || '';

    return [
      {
        id: 'rain',
        name: 'Rain',
        category: 'nature',
        duration: 1800,
        url: `${cdnBaseUrl}/audio/rain.mp3`,
        cover: `${cdnBaseUrl}/images/rain.jpg`,
        mappedDeviceSound: 'rain',
      },
      {
        id: 'wind',
        name: 'Wind',
        category: 'nature',
        duration: 1800,
        url: `${cdnBaseUrl}/audio/wind.mp3`,
        cover: `${cdnBaseUrl}/images/wind.jpg`,
        mappedDeviceSound: 'wind',
      },
      {
        id: 'bird',
        name: 'Thunder',
        category: 'nature',
        duration: 1800,
        url: `${cdnBaseUrl}/audio/bird.mp3`,
        cover: `${cdnBaseUrl}/images/bird.jpg`,
        mappedDeviceSound: 'bird',
      },
      {
        id: 'thunder',
        name: 'Thunder',
        category: 'nature',
        duration: 1800,
        url: `${cdnBaseUrl}/audio/thunder.mp3`,
        cover: `${cdnBaseUrl}/images/thunder.jpg`,
        mappedDeviceSound: 'thunder',
      },
    ];
  }

  private async cloudRecognize(
    deviceId: string,
    audioData?: string,
    userId?: string,
  ) {
    const appId = this.configService.get<string>('BAIDU_ASR_APP_ID');
    const apiKey = this.configService.get<string>('BAIDU_ASR_API_KEY');
    const secretKey = this.configService.get<string>('BAIDU_ASR_SECRET_KEY');

    if (!appId || !apiKey || !secretKey) {
      throw new NotFoundException('Baidu ASR configuration missing');
    }

    try {
      const accessToken = await this.getBaiduAccessToken(apiKey, secretKey);
      const recognitionResult = await this.callBaiduASR(accessToken, audioData);

      const result = {
        text: recognitionResult.text,
        confidence: recognitionResult.confidence,
        intent: this.parseIntent(recognitionResult.text),
        entities: this.parseEntities(recognitionResult.text),
      };
      this.record(this.recognitionHistory, { userId, deviceId, ...result });
      return result;
    } catch (error) {
      throw new NotFoundException('Speech recognition failed');
    }
  }

  private async getBaiduAccessToken(
    apiKey: string,
    secretKey: string,
  ): Promise<string> {
    const response = await fetch(
      `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`,
    );
    if (!response.ok)
      throw new Error(`Baidu token request failed: ${response.status}`);
    const data = await response.json();
    if (!data.access_token)
      throw new Error('Baidu token response has no access_token');
    return data.access_token;
  }

  private async callBaiduASR(
    accessToken: string,
    audioData?: string,
  ): Promise<any> {
    if (!audioData) throw new Error('Audio payload is required');
    let audio = audioData;
    if (/^https?:\/\//i.test(audioData)) {
      const audioResponse = await fetch(audioData);
      if (!audioResponse.ok)
        throw new Error('Unable to download audio payload');
      audio = Buffer.from(await audioResponse.arrayBuffer()).toString('base64');
    } else if (audioData.includes(',')) {
      audio = audioData.slice(audioData.indexOf(',') + 1);
    }
    const response = await fetch(
      `https://vop.baidu.com/server_api?dev_pid=1537&cuid=sleep-monitor&token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mp3; rate=16000' },
        body: Buffer.from(audio, 'base64'),
      },
    );
    const data = await response.json();
    if (!response.ok || data.err_no !== 0 || !Array.isArray(data.result)) {
      throw new Error(`Baidu ASR failed: ${data.err_msg || response.status}`);
    }
    return { text: String(data.result[0] || '').trim(), confidence: 0.9 };
  }

  private async callBaiduTTS(
    accessToken: string,
    text: string,
    voice: string,
    speed: number,
  ): Promise<string> {
    const cuid = 'sleep-monitor';
    const params = new URLSearchParams({
      tex: text,
      tok: accessToken,
      cuid,
      ctp: '1',
      lan: 'zh',
      spd: String(Math.round(speed * 5)),
      pit: '5',
      vol: '5',
      per: voice === 'male' ? '3' : '1',
      aue: '3',
    });
    const response = await fetch('https://tsn.baidu.com/text2audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('audio')) {
      const error = await response.text();
      throw new Error(`Baidu TTS failed: ${error}`);
    }
    return `data:audio/mp3;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  }

  private record(
    store: Array<Record<string, unknown>>,
    record: Record<string, unknown>,
  ) {
    store.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      ...record,
    });
    if (store.length > 100) store.length = 100;
  }

  private estimateDuration(text: string, speed: number) {
    const baseDuration = Math.max(text.length * 0.35, 1);
    return Math.round((baseDuration / speed) * 1000);
  }

  private parseIntent(text: string): string {
    if (
      text.includes('打开台灯') ||
      text.includes('关闭台灯') ||
      text.includes('调亮') ||
      text.includes('调暗') ||
      text.includes('色温')
    ) {
      return 'light_control';
    }

    if (text.includes('播放白噪音') || text.includes('停止白噪音')) {
      return 'audio_control';
    }

    return 'unknown';
  }

  private parseEntities(text: string): Record<string, any> {
    const entities: Record<string, any> = {};

    if (text.includes('打开')) {
      entities.action = 'turn_on';
    } else if (text.includes('关闭')) {
      entities.action = 'turn_off';
    } else if (text.includes('调亮')) {
      entities.action = 'brightness_up';
    } else if (text.includes('调暗')) {
      entities.action = 'brightness_down';
    }

    if (text.includes('台灯')) {
      entities.target = 'lamp';
    }

    if (text.includes('白噪音')) {
      entities.target = 'white_noise';
    }

    return entities;
  }
}
