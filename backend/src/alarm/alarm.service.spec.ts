import { AlarmService } from './alarm.service';

describe('AlarmService pending alarm authorization', () => {
  it('returns alarms owned by the user or one of the user devices', async () => {
    const prisma = {
      userDevice: {
        findMany: jest.fn().mockResolvedValue([{ deviceId: 'shared-device' }]),
      },
    };
    const stateService = {
      getPendingAlarms: jest.fn().mockResolvedValue([
        { alarmId: 'own-alarm', userId: 'user-1', deviceId: 'own-device' },
        {
          alarmId: 'shared-alarm',
          userId: 'user-2',
          deviceId: 'shared-device',
        },
        {
          alarmId: 'forbidden-alarm',
          userId: 'user-2',
          deviceId: 'foreign-device',
        },
      ]),
    };
    const service = new AlarmService(
      prisma as any,
      {} as any,
      {} as any,
      stateService as any,
      {} as any,
    );

    const result = await service.getPendingAlarms('user-1');

    expect(result.map((alarm) => alarm.alarmId)).toEqual([
      'own-alarm',
      'shared-alarm',
    ]);
    expect(prisma.userDevice.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        deviceId: { in: ['own-device', 'shared-device', 'foreign-device'] },
      },
      select: { deviceId: true },
    });
  });
});
