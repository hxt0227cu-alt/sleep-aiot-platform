import { PrismaService } from '../database/prisma.service';
import { AgentDispatcherService } from '../integration/agent-dispatcher.service';
import { OutboxService } from '../integration/outbox.service';
import { TenantService } from '../tenant/tenant.service';
import { AgentRunService } from './agent-run.service';
import { BadRequestException } from '@nestjs/common';

describe('AgentRunService durable execution signals', () => {
  it('persists the approval snapshot without a second execution refresh', async () => {
    const current = {
      id: 'run-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'waiting_approval',
      startedAt: null,
    };
    const findFirst = jest.fn().mockResolvedValue(current);
    const update = jest.fn().mockResolvedValue({
      ...current,
      status: 'running',
      startedAt: new Date(),
    });
    const getMembership = jest
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-a', role: 'owner' });
    const requireRole = jest.fn().mockResolvedValue({ role: 'owner' });
    const audit = jest.fn().mockResolvedValue(undefined);
    const isEnabled = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const getExecution = jest.fn();
    const signalExecution = jest.fn().mockResolvedValue({
      run_id: 'run-1',
      tenant_id: 'tenant-a',
      status: 'running',
    });
    const service = new AgentRunService(
      { agentRun: { findFirst, update } } as unknown as PrismaService,
      {
        getMembership,
        requireRole,
        audit,
      } as unknown as TenantService,
      {} as unknown as OutboxService,
      {
        isEnabled,
        getExecution,
        signalExecution,
      } as unknown as AgentDispatcherService,
    );

    const result = await service.approve('user-1', 'run-1', 'tenant-a');

    expect(result.status).toBe('running');
    expect(signalExecution).toHaveBeenCalledWith(
      'run-1',
      'tenant-a',
      'approve',
    );
    expect(getExecution).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('persists the cancellation snapshot without a duplicate transition', async () => {
    const current = {
      id: 'run-2',
      tenantId: 'tenant-a',
      userId: 'user-1',
      status: 'running',
    };
    const findFirst = jest.fn().mockResolvedValue(current);
    const update = jest.fn().mockResolvedValue({
      ...current,
      status: 'cancelled',
      cancelledAt: new Date(),
    });
    const getMembership = jest
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-a', role: 'member' });
    const isEnabled = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const getExecution = jest.fn();
    const signalExecution = jest.fn().mockResolvedValue({
      run_id: 'run-2',
      tenant_id: 'tenant-a',
      status: 'cancelled',
    });
    const service = new AgentRunService(
      { agentRun: { findFirst, update } } as unknown as PrismaService,
      { getMembership } as unknown as TenantService,
      {} as unknown as OutboxService,
      {
        isEnabled,
        getExecution,
        signalExecution,
      } as unknown as AgentDispatcherService,
    );

    const result = await service.cancel('user-1', 'run-2', 'tenant-a');

    expect(result.status).toBe('cancelled');
    expect(signalExecution).toHaveBeenCalledWith('run-2', 'tenant-a', 'cancel');
    expect(getExecution).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('derives preference memory identity from tenant membership', async () => {
    const getMembership = jest
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-a', role: 'member' });
    const createPreferenceMemory = jest.fn().mockResolvedValue({
      memory_id: 'memory-1',
      tenant_id: 'tenant-a',
      user_id: 'user-1',
    });
    const service = new AgentRunService(
      {} as unknown as PrismaService,
      { getMembership } as unknown as TenantService,
      {} as unknown as OutboxService,
      { createPreferenceMemory } as unknown as AgentDispatcherService,
    );

    await service.createPreferenceMemory(
      'user-1',
      {
        preferenceKey: 'sleep.window',
        value: { start: '22:00' },
        source: 'user_setting',
        purpose: 'personalize_sleep_plan',
        consentId: 'consent-v1',
        expiresAt: '2026-09-01T00:00:00.000Z',
      },
      'untrusted-tenant',
    );

    expect(createPreferenceMemory).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', userId: 'user-1' }),
    );
  });

  it('rejects raw health memory before tenant or execution access', async () => {
    const getMembership = jest.fn();
    const createPreferenceMemory = jest.fn();
    const service = new AgentRunService(
      {} as unknown as PrismaService,
      { getMembership } as unknown as TenantService,
      {} as unknown as OutboxService,
      { createPreferenceMemory } as unknown as AgentDispatcherService,
    );

    await expect(
      service.createPreferenceMemory('user-1', {
        preferenceKey: 'sleep.raw',
        value: { heart_rate_series: [60, 61] },
        source: 'device',
        purpose: 'personalize_sleep_plan',
        consentId: 'consent-v1',
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getMembership).not.toHaveBeenCalled();
    expect(createPreferenceMemory).not.toHaveBeenCalled();
  });
});
