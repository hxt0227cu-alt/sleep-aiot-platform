import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports dependency status and updates metrics', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const redis = {
      getClient: () => ({ ping: jest.fn().mockResolvedValue('PONG') }),
    };
    const mqtt = { isConnected: jest.fn().mockReturnValue(true) };
    const metrics = { dependencyHealth: { set: jest.fn() } };
    const service = new HealthService(
      prisma as any,
      redis as any,
      mqtt as any,
      metrics as any,
    );

    await expect(service.readiness()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        postgres: { ready: true },
        redis: { ready: true },
        mqtt: { ready: true },
      },
    });
    expect(metrics.dependencyHealth.set).toHaveBeenCalledTimes(3);
  });

  it('marks Redis as unavailable when ping fails', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const redis = {
      getClient: () => ({
        ping: jest.fn().mockRejectedValue(new Error('down')),
      }),
    };
    const mqtt = { isConnected: jest.fn().mockReturnValue(true) };
    const metrics = { dependencyHealth: { set: jest.fn() } };
    const service = new HealthService(
      prisma as any,
      redis as any,
      mqtt as any,
      metrics as any,
    );

    await expect(service.readiness()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { redis: { ready: false } },
    });
  });
});
