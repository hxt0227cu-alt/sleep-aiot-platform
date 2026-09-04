import { WebSocketService } from './websocket.service';

describe('WebSocketService', () => {
  const fanout = {
    publishToDevice: jest.fn(),
    publishToUser: jest.fn(),
    publishToAll: jest.fn(),
  } as any;
  const gateway = {
    getConnectedClientsCount: jest.fn(() => 0),
    getConnectedUsersCount: jest.fn(() => 0),
    getConnectedDevicesCount: jest.fn(() => 0),
    isUserConnected: jest.fn(() => false),
    isDeviceConnected: jest.fn(() => false),
  } as any;

  let service: WebSocketService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebSocketService(gateway, fanout);
  });

  it('emits device_status with compatibility fields', () => {
    service.sendDeviceStatus('lamp_001', true, 'online', {
      lastSeen: 1710000000000,
      firmwareVersion: '1.0.0',
      light: {
        power: true,
        brightness: 60,
        colorTemp: 4000,
      },
    });

    expect(fanout.publishToDevice).toHaveBeenCalledWith(
      'lamp_001',
      expect.objectContaining({
        type: 'device_status',
        data: expect.objectContaining({
          deviceId: 'lamp_001',
          device_id: 'lamp_001',
          online: true,
          status: 'online',
          lastSeen: 1710000000000,
          last_seen: 1710000000000,
          firmwareVersion: '1.0.0',
          firmware_version: '1.0.0',
        }),
      }),
    );
  });

  it('emits vital_signs with both camelCase and snake_case fields', () => {
    service.sendVitalSigns('lamp_001', {
      deviceId: 'lamp_001',
      timestamp: 1710000000000,
      heartRate: 72,
      breathingRate: 16,
      bodyMovement: 0.2,
      sleepState: 'light_sleep',
      sleepScore: 88,
      confidence: 0.93,
    });

    expect(fanout.publishToDevice).toHaveBeenCalledWith(
      'lamp_001',
      expect.objectContaining({
        type: 'vital_signs',
        data: expect.objectContaining({
          deviceId: 'lamp_001',
          device_id: 'lamp_001',
          heartRate: 72,
          breathingRate: 16,
          bodyMovement: 0.2,
          sleepState: 'light_sleep',
          sleepScore: 88,
          sleep_score: 88,
          heart_rate: expect.objectContaining({ value: 72 }),
          breathing_rate: expect.objectContaining({ value: 16 }),
          body_movement: expect.objectContaining({ value: 0.2 }),
          sleep_state: expect.objectContaining({ state: 'light_sleep' }),
        }),
      }),
    );
  });

  it('emits command_response with command_id compatibility field', () => {
    service.sendCommandResponse('lamp_001', {
      commandId: 'cmd_001',
      deviceId: 'lamp_001',
      status: 'success',
      result: { applied: true },
      timestamp: 1710000000000,
    });

    expect(fanout.publishToDevice).toHaveBeenCalledWith(
      'lamp_001',
      expect.objectContaining({
        type: 'command_response',
        data: expect.objectContaining({
          deviceId: 'lamp_001',
          device_id: 'lamp_001',
          commandId: 'cmd_001',
          command_id: 'cmd_001',
          status: 'success',
          result: { applied: true },
        }),
      }),
    );
  });

  it('emits sleep_report with normalized duration and vital_signs fields', () => {
    service.sendSleepReport('lamp_001', {
      reportDate: '2026-05-27',
      sleepScore: 91,
      sleepDuration: {
        total: 480,
        deep: 120,
        light: 240,
        rem: 90,
        awake: 30,
      },
      vitalSigns: {
        avgHeartRate: 62,
        minHeartRate: 55,
        maxHeartRate: 78,
        avgBreathingRate: 15,
        minBreathingRate: 12,
        maxBreathingRate: 18,
      },
      healthSuggestions: ['keep'],
      timestamp: 1710000000000,
    });

    expect(fanout.publishToDevice).toHaveBeenCalledWith(
      'lamp_001',
      expect.objectContaining({
        type: 'sleep_report',
        data: expect.objectContaining({
          deviceId: 'lamp_001',
          device_id: 'lamp_001',
          reportDate: '2026-05-27',
          report_date: '2026-05-27',
          sleepScore: 91,
          sleep_score: 91,
          sleepDuration: expect.objectContaining({ deep: 120 }),
          sleep_duration: expect.objectContaining({ deep_sleep: 120 }),
          vitalSigns: expect.objectContaining({ avgHeartRate: 62 }),
          vital_signs: expect.objectContaining({ avg_heart_rate: 62 }),
          healthSuggestions: ['keep'],
          health_suggestions: ['keep'],
        }),
      }),
    );
  });
});
