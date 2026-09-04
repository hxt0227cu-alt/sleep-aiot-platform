import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceService } from './voice.service';

describe('VoiceService', () => {
  const values: Record<string, string> = {
    BAIDU_ASR_APP_ID: 'app',
    BAIDU_ASR_API_KEY: 'key',
    BAIDU_ASR_SECRET_KEY: 'secret',
    CDN_BASE_URL: 'https://cdn.example.test',
  };
  let service: VoiceService;

  beforeEach(() => {
    service = new VoiceService({
      get: (key: string) => values[key],
    } as ConfigService);
    jest.restoreAllMocks();
  });

  it('exposes the same sound identifiers supported by firmware', async () => {
    const result = await service.getWhiteNoiseList();

    expect(result.sounds.map((sound) => sound.id)).toEqual([
      'rain',
      'wind',
      'bird',
      'thunder',
    ]);
    expect(
      result.sounds.every((sound) => sound.id === sound.mappedDeviceSound),
    ).toBe(true);
  });

  it('does not return a fabricated local recognition result', async () => {
    await expect(
      service.recognize({
        deviceId: 'device-1',
        audioData: 'audio',
        recognitionMode: 'local',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the text produced by Baidu ASR and records it for the user', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ err_no: 0, result: ['关闭台灯'] }),
      } as Response);

    const result = await service.recognize(
      {
        deviceId: 'device-1',
        audioData: 'data:audio/mp3;base64,YXVkaW8=',
        recognitionMode: 'cloud',
      },
      'user-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ text: '关闭台灯', intent: 'light_control' });
    expect(await service.getRecognitionHistory('user-1')).toMatchObject({
      total: 1,
    });
  });
});
