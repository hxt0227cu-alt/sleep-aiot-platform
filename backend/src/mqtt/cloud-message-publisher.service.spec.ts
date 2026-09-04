import { CloudMessagePublisherService } from './cloud-message-publisher.service';

describe('CloudMessagePublisherService stateless delivery', () => {
  it('does not acknowledge until a bounded retry publishes successfully', async () => {
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    const service = new CloudMessagePublisherService(
      { isConnected: () => true, publish } as any,
      undefined as any,
      undefined as any,
    );

    await service.sendConfigToDevice('device-1', 'brightness', 30);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(service.getQueueStatus()).toMatchObject({
      queueSize: 0,
      isProcessing: false,
      stats: { totalSent: 1, totalFailed: 0 },
    });
  });
});
