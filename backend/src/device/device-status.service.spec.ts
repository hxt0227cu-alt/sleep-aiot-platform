import { DeviceStatusService } from './device-status.service';

describe('DeviceStatusService database authority', () => {
  const redis = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
  };
  const websocket = { sendDeviceStatus: jest.fn() };
  const leader = { runIfLeader: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('does not let an older replica observation overwrite authoritative state', async () => {
    const prisma = {
      device: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = new DeviceStatusService(
      prisma as any,
      redis as any,
      websocket as any,
      leader as any,
    );

    await service.updateDeviceStatus('device-1', { lastSeen: 1000 });

    expect(redis.set).not.toHaveBeenCalled();
    expect(websocket.sendDeviceStatus).not.toHaveBeenCalled();
  });

  it('publishes only after the last-write-wins database update succeeds', async () => {
    const prisma = {
      device: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new DeviceStatusService(
      prisma as any,
      redis as any,
      websocket as any,
      leader as any,
    );

    await service.updateDeviceStatus('device-1', { lastSeen: 2000 });

    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(websocket.sendDeviceStatus).toHaveBeenCalledWith('device-1', true);
  });
});
