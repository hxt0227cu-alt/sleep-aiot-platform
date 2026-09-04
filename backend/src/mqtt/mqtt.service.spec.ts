import { Test, TestingModule } from '@nestjs/testing';
import { MqttService } from './mqtt.service';
import { ConfigService } from '@nestjs/config';

describe('MqttService', () => {
  let service: MqttService;
  let configService: Partial<ConfigService>;

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string) => {
        const config = {
          MQTT_BROKER_URL: 'mqtt://localhost:1883',
          MQTT_USERNAME: 'hxt',
          MQTT_PASSWORD: '123456',
        };
        return config[key as keyof typeof config];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MqttService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<MqttService>(MqttService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('derives a stable client id from the replica identity', () => {
    const previous = process.env.HOSTNAME;
    process.env.HOSTNAME = 'backend-api-7d9f';
    const internal = service as unknown as { resolveClientId(): string };
    expect(internal.resolveClientId()).toBe('sleep-backend-backend-api-7d9f');
    if (previous === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = previous;
  });

  it('rejects callbacks for topics not owned by backend', () => {
    expect(() =>
      service.registerOwnedTopicCallback('device/+/telemetry', jest.fn()),
    ).toThrow('MQTT topic is not owned by backend');
  });

  describe('topicMatches', () => {
    const topicMatches = () =>
      service as unknown as {
        topicMatches(topic: string, pattern: string): boolean;
      };

    it('should match exact topic', () => {
      expect(
        topicMatches().topicMatches(
          'device/test/telemetry',
          'device/test/telemetry',
        ),
      ).toBe(true);
    });

    it('should match single level wildcard', () => {
      expect(
        topicMatches().topicMatches(
          'device/test/telemetry',
          'device/+/telemetry',
        ),
      ).toBe(true);
    });

    it('should not match different topics', () => {
      expect(
        topicMatches().topicMatches(
          'device/test/telemetry',
          'device/test/status',
        ),
      ).toBe(false);
    });
  });
});
