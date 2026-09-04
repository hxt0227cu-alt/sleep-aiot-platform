import { ConfigService } from '@nestjs/config';
import { AgentDispatcherService } from './agent-dispatcher.service';
import { OutboxService } from './outbox.service';

describe('AgentDispatcherService', () => {
  it('dispatches the same persistent run id to the Python execution plane', async () => {
    const outbox = {} as unknown as OutboxService;
    const config = {
      get: jest.fn().mockReturnValue('http://agent.test'),
    } as unknown as ConfigService;
    const service = new AgentDispatcherService(outbox, config);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'queued' }),
    } as Response);

    await service.dispatch({
      runId: 'run-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      agentType: 'sleep_analysis',
      workflowVersion: 'v1',
      input: { device_id: 'sim-1' },
    });

    expect(fetchMock).toHaveBeenCalled();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://agent.test/v1/runs');
    expect(request.body).toEqual(expect.stringContaining('"run_id":"run-1"'));
    fetchMock.mockRestore();
  });

  it('reads a tenant-scoped execution snapshot', async () => {
    const outbox = {} as unknown as OutboxService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'AGENT_SERVICE_URL' ? 'http://agent.test' : 'true',
      ),
    } as unknown as ConfigService;
    const service = new AgentDispatcherService(outbox, config);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ run_id: 'run-1', status: 'succeeded' }),
    } as Response);

    const result = await service.getExecution('run-1', 'tenant-1');

    expect(result?.status).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://agent.test/v1/runs/run-1',
      expect.objectContaining({
        headers: { 'x-tenant-id': 'tenant-1' },
      }),
    );
    fetchMock.mockRestore();
  });

  it('forwards approval with the tenant boundary', async () => {
    const outbox = {} as unknown as OutboxService;
    const config = {
      get: jest.fn().mockReturnValue('http://agent.test'),
    } as unknown as ConfigService;
    const service = new AgentDispatcherService(outbox, config);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ run_id: 'run-1', status: 'running' }),
    } as Response);

    await service.signalExecution('run-1', 'tenant-1', 'approve');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://agent.test/v1/runs/run-1/approve',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-tenant-id': 'tenant-1' },
      }),
    );
    fetchMock.mockRestore();
  });
});
