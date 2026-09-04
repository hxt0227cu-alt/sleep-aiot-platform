import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { VoiceService } from './voice.service';
import { RecognizeDto } from './dto/recognize.dto';
import { TtsDto } from './dto/tts.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('语音功能')
@ApiBearerAuth()
@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(private readonly voiceService: VoiceService) {}

  /**
   * 获取白噪音列表
   */
  @Get('white-noise')
  @ApiOperation({
    summary: '获取白噪音列表',
    description: '获取所有可用的白噪音类型',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getWhiteNoiseList() {
    try {
      this.logger.debug('Fetching white noise list');
      return await this.voiceService.getWhiteNoiseList();
    } catch (error) {
      this.logger.error(
        `Failed to fetch white noise list: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 语音识别
   */
  @Post('recognize')
  @ApiOperation({ summary: '语音识别', description: '将语音文件转换为文本' })
  @ApiResponse({ status: 200, description: '识别成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async recognize(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) recognizeDto: RecognizeDto,
  ) {
    try {
      // 验证音频URL
      if (!recognizeDto.audioUrl && !recognizeDto.audioData) {
        throw new Error('Audio URL or audio data is required');
      }

      if (recognizeDto.audioUrl) {
        if (
          recognizeDto.audioUrl.length < 10 ||
          recognizeDto.audioUrl.length > 500
        ) {
          throw new Error('Invalid audio URL');
        }

        try {
          const url = new URL(recognizeDto.audioUrl);
          if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('Audio URL must use HTTP or HTTPS protocol');
          }
        } catch (error) {
          throw new Error('Invalid audio URL format');
        }
      }

      // 验证语言代码
      if (recognizeDto.language) {
        const validLanguages = [
          'zh-CN',
          'en-US',
          'ja-JP',
          'ko-KR',
          'fr-FR',
          'de-DE',
          'es-ES',
        ];
        if (!validLanguages.includes(recognizeDto.language)) {
          throw new Error(
            `Invalid language code. Must be one of: ${validLanguages.join(', ')}`,
          );
        }
      }

      // 验证音频格式
      if (recognizeDto.format) {
        const validFormats = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
        if (!validFormats.includes(recognizeDto.format)) {
          throw new Error(
            `Invalid audio format. Must be one of: ${validFormats.join(', ')}`,
          );
        }
      }

      // 验证采样率
      if (
        recognizeDto.sampleRate &&
        (recognizeDto.sampleRate < 8000 || recognizeDto.sampleRate > 48000)
      ) {
        throw new Error('Sample rate must be between 8000 and 48000 Hz');
      }

      this.logger.log(`Voice recognition request for user ${user.id}`);
      return await this.voiceService.recognize(recognizeDto, user.id);
    } catch (error) {
      this.logger.error(
        `Voice recognition failed: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 文本转语音
   */
  @Post('tts')
  @ApiOperation({ summary: '文本转语音', description: '将文本转换为语音文件' })
  @ApiResponse({ status: 200, description: '转换成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async textToSpeech(
    @CurrentUser() user: any,
    @Body(new ValidationPipe({ transform: true })) ttsDto: TtsDto,
  ) {
    try {
      // 验证文本内容
      if (!ttsDto.text || ttsDto.text.length < 1 || ttsDto.text.length > 1000) {
        throw new Error('Text must be between 1 and 1000 characters');
      }

      // 验证语言代码
      if (ttsDto.language) {
        const validLanguages = [
          'zh-CN',
          'en-US',
          'ja-JP',
          'ko-KR',
          'fr-FR',
          'de-DE',
          'es-ES',
        ];
        if (!validLanguages.includes(ttsDto.language)) {
          throw new Error(
            `Invalid language code. Must be one of: ${validLanguages.join(', ')}`,
          );
        }
      }

      // 验证语音类型
      if (ttsDto.voice) {
        const validVoices = ['female', 'male', 'child'];
        if (!validVoices.includes(ttsDto.voice)) {
          throw new Error(
            `Invalid voice type. Must be one of: ${validVoices.join(', ')}`,
          );
        }
      }

      // 验证语速
      if (
        ttsDto.speed !== undefined &&
        (ttsDto.speed < 0.5 || ttsDto.speed > 2.0)
      ) {
        throw new Error('Speed must be between 0.5 and 2.0');
      }

      // 验证音调
      if (
        ttsDto.pitch !== undefined &&
        (ttsDto.pitch < 0.5 || ttsDto.pitch > 2.0)
      ) {
        throw new Error('Pitch must be between 0.5 and 2.0');
      }

      // 验证音量
      if (
        ttsDto.volume !== undefined &&
        (ttsDto.volume < 0 || ttsDto.volume > 1)
      ) {
        throw new Error('Volume must be between 0 and 1');
      }

      // 验证输出格式
      if (ttsDto.format) {
        const validFormats = ['mp3', 'wav', 'ogg'];
        if (!validFormats.includes(ttsDto.format)) {
          throw new Error(
            `Invalid output format. Must be one of: ${validFormats.join(', ')}`,
          );
        }
      }

      this.logger.log(
        `TTS request for user ${user.id}: ${ttsDto.text.substring(0, 50)}...`,
      );
      return await this.voiceService.textToSpeech(ttsDto, user.id);
    } catch (error) {
      this.logger.error(`TTS failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 播放白噪音
   */
  @Post('play-white-noise')
  @ApiOperation({ summary: '播放白噪音', description: '为指定设备播放白噪音' })
  @ApiResponse({ status: 200, description: '播放成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async playWhiteNoise(
    @CurrentUser() user: any,
    @Body()
    body: {
      deviceId: string;
      noiseType: string;
      volume?: number;
      duration?: number;
    },
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!body.deviceId || !deviceIdRegex.test(body.deviceId)) {
        throw new Error('Invalid device ID format');
      }

      // 验证噪音类型
      const validNoiseTypes = ['rain', 'wind', 'bird', 'thunder'];
      if (!body.noiseType || !validNoiseTypes.includes(body.noiseType)) {
        throw new Error(
          `Invalid noise type. Must be one of: ${validNoiseTypes.join(', ')}`,
        );
      }

      // 验证音量
      if (body.volume !== undefined && (body.volume < 0 || body.volume > 1)) {
        throw new Error('Volume must be between 0 and 1');
      }

      // 验证持续时间
      if (
        body.duration !== undefined &&
        (body.duration < 1 || body.duration > 3600)
      ) {
        throw new Error('Duration must be between 1 and 3600 seconds');
      }

      this.logger.log(
        `Playing white noise ${body.noiseType} for device ${body.deviceId}`,
      );
      return await this.voiceService.playWhiteNoise(
        body.deviceId,
        body.noiseType,
        body.volume,
        body.duration,
      );
    } catch (error) {
      this.logger.error(
        `Failed to play white noise: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 停止白噪音
   */
  @Post('stop-white-noise')
  @ApiOperation({
    summary: '停止白噪音',
    description: '停止指定设备的白噪音播放',
  })
  @ApiResponse({ status: 200, description: '停止成功' })
  @ApiResponse({ status: 400, description: '请求参数错误' })
  @HttpCode(HttpStatus.OK)
  async stopWhiteNoise(
    @CurrentUser() user: any,
    @Body() body: { deviceId: string },
  ) {
    try {
      // 验证设备ID格式
      const deviceIdRegex = /^[a-zA-Z0-9_-]{8,32}$/;
      if (!body.deviceId || !deviceIdRegex.test(body.deviceId)) {
        throw new Error('Invalid device ID format');
      }

      this.logger.log(`Stopping white noise for device ${body.deviceId}`);
      return await this.voiceService.stopWhiteNoise(body.deviceId);
    } catch (error) {
      this.logger.error(
        `Failed to stop white noise: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取语音识别历史
   */
  @Get('recognition-history')
  @ApiOperation({
    summary: '获取语音识别历史',
    description: '获取当前用户的语音识别历史记录',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getRecognitionHistory(@CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching recognition history for user ${user.id}`);
      return await this.voiceService.getRecognitionHistory(user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch recognition history: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * 获取TTS历史
   */
  @Get('tts-history')
  @ApiOperation({
    summary: '获取TTS历史',
    description: '获取当前用户的文本转语音历史记录',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getTtsHistory(@CurrentUser() user: any) {
    try {
      this.logger.debug(`Fetching TTS history for user ${user.id}`);
      return await this.voiceService.getTtsHistory(user.id);
    } catch (error) {
      this.logger.error(
        `Failed to fetch TTS history: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
