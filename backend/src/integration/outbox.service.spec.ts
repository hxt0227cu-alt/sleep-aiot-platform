import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  it('enqueues a versioned tenant event', async () => {
    const prisma = {
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
    } as any;
    const service = new OutboxService(prisma);

    await service.enqueue({
      tenantId: 'tenant-1',
      aggregateType: 'device',
      aggregateId: 'device-1',
      eventType: 'device.bound',
      payload: { userId: 'user-1' },
    });

    expect(prisma.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        eventType: 'device.bound',
        schemaVersion: 1,
      }),
    });
  });

  it('moves repeatedly failing events to dead letter', async () => {
    const prisma = {
      outboxEvent: {
        update: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
    } as any;
    const service = new OutboxService(prisma);

    await service.markFailed('event-1', 10, new Error('broker down'));

    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'dead_letter',
          lastError: 'broker down',
        }),
      }),
    );
  });
});
