import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { OutboxService } from '../integration/outbox.service';
import { AgentDispatcherService } from '../integration/agent-dispatcher.service';
import { AgentRunService } from './agent-run.service';

const firstArgument = <T>(mock: jest.Mock<unknown, unknown[]>): T => {
  const call = mock.mock.calls.at(0);
  if (!call) throw new Error('Expected mock to have been called');
  return call[0] as T;
};

describe('AgentRunService', () => {
  const prisma = {
    device: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
    },
    agentRun: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
    },
  };
  const tenants = {
    getMembership: jest.fn<Promise<unknown>, [string, string?]>(),
    audit: jest.fn<Promise<unknown>, [unknown]>(),
  };
  const outbox = { enqueue: jest.fn<Promise<unknown>, [unknown]>() };
  const dispatcher = {
    isEnabled: jest.fn<boolean, []>().mockReturnValue(false),
    getExecution: jest.fn<Promise<unknown>, [string, string]>(),
  };

  const createService = () =>
    new AgentRunService(
      prisma as unknown as PrismaService,
      tenants as unknown as TenantService,
      outbox as unknown as OutboxService,
      dispatcher as unknown as AgentDispatcherService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    tenants.getMembership.mockResolvedValue({
      tenantId: 'tenant-a',
      role: 'owner',
    });
    tenants.audit.mockResolvedValue({});
    outbox.enqueue.mockResolvedValue({ id: 'event-1' });
    dispatcher.isEnabled.mockReturnValue(false);
  });

  it('creates a tenant-scoped queued run and audit event', async () => {
    prisma.agentRun.create.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-a',
      status: 'queued',
      queuedAt: new Date('2026-07-22T00:00:00.000Z'),
    });
    const service = createService();

    const result = await service.create('user-1', {
      agentType: 'sleep_analysis',
      input: { question: '趋势' },
      requestId: 'request-1',
    });

    expect(result).toMatchObject({ runId: 'run-1', tenantId: 'tenant-a' });
    expect(prisma.agentRun.create).toHaveBeenCalled();
    const createInput = firstArgument<{
      data: { tenantId: string; userId: string; status: string };
    }>(prisma.agentRun.create);
    expect(createInput.data).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'queued',
    });
    expect(tenants.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.run.create',
        resourceId: 'run-1',
        outcome: 'success',
      }),
    );
    expect(outbox.enqueue).toHaveBeenCalled();
    const event = firstArgument<{
      aggregateId: string;
      eventType: string;
      payload: { runId: string; tenantId: string };
    }>(outbox.enqueue);
    expect(event).toMatchObject({
      aggregateId: 'run-1',
      eventType: 'agent.run.requested',
      payload: { runId: 'run-1', tenantId: 'tenant-a' },
    });
  });

  it('rejects an invalid terminal state transition', async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'succeeded',
    });
    const service = createService();

    await expect(
      service.transition('user-1', 'run-1', 'running'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.agentRun.update).not.toHaveBeenCalled();
  });

  it('rejects raw health data before tenant lookup or persistence', async () => {
    const service = createService();

    await expect(
      service.create('user-1', {
        agentType: 'sleep_report',
        input: {
          device_id: 'sim-1',
          payload: { radar_samples: [1, 2, 3] },
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tenants.getMembership).not.toHaveBeenCalled();
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('derives device authorization from the tenant binding', async () => {
    prisma.device.findFirst.mockResolvedValue({ id: 'device-1' });
    prisma.agentRun.create.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-a',
      status: 'queued',
      queuedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const service = createService();

    await service.create('user-1', {
      agentType: 'sleep_report',
      input: {
        device_id: 'device-1',
        allowed_device_ids: ['untrusted-device'],
      },
    });

    expect(prisma.device.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'device-1',
        tenantId: 'tenant-a',
        userDevices: { some: { userId: 'user-1' } },
      },
      select: { id: true },
    });
    const authorizedCreate = firstArgument<{
      data: { input: { allowed_device_ids: string[] } };
    }>(prisma.agentRun.create);
    expect(authorizedCreate.data.input.allowed_device_ids).toEqual([
      'device-1',
    ]);
  });

  it('synchronizes a completed business result from the execution plane', async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'running',
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      completedAt: null,
    });
    prisma.agentRun.update.mockResolvedValue({
      id: 'run-1',
      status: 'succeeded',
      output: { businessResult: { contractVersion: 'sleep-report.v1' } },
    });
    dispatcher.isEnabled.mockReturnValue(true);
    dispatcher.getExecution.mockResolvedValue({
      run_id: 'run-1',
      tenant_id: 'tenant-a',
      status: 'succeeded',
      output: { businessResult: { contractVersion: 'sleep-report.v1' } },
      updated_at: '2026-08-01T00:00:01.000Z',
    });
    const service = createService();

    const result = await service.get('user-1', 'run-1');

    expect(result.status).toBe('succeeded');
    expect(dispatcher.getExecution).toHaveBeenCalledWith('run-1', 'tenant-a');
    const synchronizedUpdate = firstArgument<{
      data: {
        status: string;
        output: { businessResult: { contractVersion: string } };
      };
    }>(prisma.agentRun.update);
    expect(synchronizedUpdate.data).toMatchObject({
      status: 'succeeded',
      output: {
        businessResult: { contractVersion: 'sleep-report.v1' },
      },
    });
  });

  it('does not persist a cross-tenant execution snapshot', async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'running',
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
      completedAt: null,
    });
    dispatcher.isEnabled.mockReturnValue(true);
    dispatcher.getExecution.mockResolvedValue({
      run_id: 'run-1',
      tenant_id: 'tenant-b',
      status: 'succeeded',
    });
    const service = createService();

    const result = await service.get('user-1', 'run-1');

    expect(result.status).toBe('running');
    expect(prisma.agentRun.update).not.toHaveBeenCalled();
  });
});
