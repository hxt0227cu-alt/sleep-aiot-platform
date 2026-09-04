import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '@prisma/client';
import { TenantService } from '../tenant/tenant.service';
import { OutboxService } from '../integration/outbox.service';
import { AgentDispatcherService } from '../integration/agent-dispatcher.service';
import { CreateAgentMemoryDto } from './dto/agent-memory.dto';

const allowedTransitions: Record<string, string[]> = {
  queued: ['running', 'cancelled', 'expired'],
  running: ['waiting_approval', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'cancelled', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

const executionStatuses = new Set([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);

const businessAgentTypes = new Set([
  'sleep_report',
  'sleep_improvement',
  'voice_companion',
  'algorithm_optimization',
]);

const deviceScopedBusinessAgentTypes = new Set([
  'sleep_report',
  'sleep_improvement',
]);

const prohibitedRawHealthFields = new Set([
  'raw_data',
  'rawData',
  'radar_samples',
  'heart_rate_series',
  'breathing_rate_series',
  'sleep_stage_series',
]);

const findProhibitedRawHealthFields = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(findProhibitedRawHealthFields);
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => [
      ...(prohibitedRawHealthFields.has(key) ? [key] : []),
      ...findProhibitedRawHealthFields(nested),
    ],
  );
};

@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: AgentDispatcherService,
  ) {}

  async create(
    userId: string,
    input: {
      agentType: string;
      input: Record<string, unknown>;
      tenantId?: string;
      workflowVersion?: string;
      requestId?: string;
    },
  ) {
    if (businessAgentTypes.has(input.agentType)) {
      const prohibited = [
        ...new Set(findProhibitedRawHealthFields(input.input)),
      ];
      if (prohibited.length > 0) {
        throw new BadRequestException(
          `Raw health fields are not accepted: ${prohibited.sort().join(', ')}`,
        );
      }
    }
    const membership = await this.tenants.getMembership(userId, input.tenantId);
    if (input.agentType === 'algorithm_optimization') {
      await this.tenants.requireRole(userId, membership.tenantId, [
        'owner',
        'admin',
      ]);
    }
    let trustedInput = input.input;
    if (deviceScopedBusinessAgentTypes.has(input.agentType)) {
      const deviceId = input.input.device_id;
      if (typeof deviceId !== 'string' || !deviceId.trim()) {
        throw new BadRequestException('device_id is required');
      }
      const device = await this.prisma.device.findFirst({
        where: {
          id: deviceId,
          tenantId: membership.tenantId,
          userDevices: { some: { userId } },
        },
        select: { id: true },
      });
      if (!device) throw new NotFoundException('Device not found');
      trustedInput = { ...input.input, allowed_device_ids: [device.id] };
    }
    const run = await this.prisma.agentRun.create({
      data: {
        tenantId: membership.tenantId,
        userId,
        agentType: input.agentType,
        workflowVersion: input.workflowVersion || 'v1',
        input: trustedInput as Prisma.InputJsonObject,
        status: 'queued',
      },
    });

    await this.outbox.enqueue({
      tenantId: membership.tenantId,
      aggregateType: 'agent_run',
      aggregateId: run.id,
      eventType: 'agent.run.requested',
      payload: {
        runId: run.id,
        tenantId: membership.tenantId,
        userId,
        agentType: input.agentType,
        workflowVersion: input.workflowVersion || 'v1',
        input: trustedInput,
        correlationId: input.requestId || run.id,
      },
    });

    await this.tenants.audit({
      tenantId: membership.tenantId,
      userId,
      requestId: input.requestId,
      action: 'agent.run.create',
      resourceType: 'agent_run',
      resourceId: run.id,
      outcome: 'success',
      metadata: { agentType: input.agentType },
    });

    return {
      runId: run.id,
      status: run.status,
      tenantId: run.tenantId,
      queuedAt: run.queuedAt,
    };
  }

  async get(userId: string, runId: string, tenantId?: string) {
    const membership = await this.tenants.getMembership(userId, tenantId);
    const run = await this.prisma.agentRun.findFirst({
      where: {
        id: runId,
        tenantId: membership.tenantId,
        OR: [
          { userId },
          {
            tenant: {
              members: {
                some: {
                  userId,
                  role: { in: ['owner', 'admin', 'viewer'] },
                  status: 'active',
                },
              },
            },
          },
        ],
      },
    });

    if (!run) {
      throw new NotFoundException('Agent run not found');
    }

    if (
      this.dispatcher.isEnabled() &&
      ['queued', 'running', 'waiting_approval'].includes(run.status)
    ) {
      try {
        const execution = await this.dispatcher.getExecution(
          run.id,
          run.tenantId,
        );
        if (execution) {
          if (
            execution.run_id !== run.id ||
            execution.tenant_id !== run.tenantId ||
            !executionStatuses.has(execution.status)
          ) {
            throw new Error('Agent execution returned an invalid snapshot');
          }
          const synchronizedStatus =
            run.status === 'running' && execution.status === 'queued'
              ? 'running'
              : execution.status;
          const terminal = ['succeeded', 'failed', 'cancelled'].includes(
            synchronizedStatus,
          );
          return await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: synchronizedStatus,
              ...(execution.output
                ? { output: execution.output as Prisma.InputJsonObject }
                : {}),
              errorMessage: execution.error || null,
              ...(!run.startedAt && synchronizedStatus !== 'queued'
                ? { startedAt: new Date() }
                : {}),
              ...(terminal && !run.completedAt
                ? {
                    completedAt: execution.updated_at
                      ? new Date(execution.updated_at)
                      : new Date(),
                  }
                : {}),
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Agent execution refresh failed for ${run.id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return run;
  }

  async transition(
    userId: string,
    runId: string,
    status: string,
    tenantId?: string,
  ) {
    const current = await this.get(userId, runId, tenantId);
    if (!allowedTransitions[current.status]?.includes(status)) {
      throw new BadRequestException(
        `Invalid agent run transition: ${current.status} -> ${status}`,
      );
    }

    return this.prisma.agentRun.update({
      where: { id: current.id },
      data: {
        status,
        ...(status === 'running' ? { startedAt: new Date() } : {}),
        ...(status === 'succeeded' || status === 'failed'
          ? { completedAt: new Date() }
          : {}),
        ...(status === 'cancelled' ? { cancelledAt: new Date() } : {}),
      },
    });
  }

  async approve(userId: string, runId: string, tenantId?: string) {
    const membership = await this.tenants.getMembership(userId, tenantId);
    await this.tenants.requireRole(userId, membership.tenantId, [
      'owner',
      'admin',
      'member',
    ]);
    const current = await this.get(userId, runId, membership.tenantId);
    let run: Awaited<ReturnType<AgentRunService['transition']>>;
    if (this.dispatcher.isEnabled()) {
      const execution = await this.dispatcher.signalExecution(
        current.id,
        membership.tenantId,
        'approve',
      );
      if (
        execution.run_id !== current.id ||
        execution.tenant_id !== membership.tenantId ||
        execution.status !== 'running'
      ) {
        throw new Error('Agent approval returned an invalid snapshot');
      }
      run = await this.prisma.agentRun.update({
        where: { id: current.id },
        data: {
          status: 'running',
          startedAt: current.startedAt || new Date(),
        },
      });
    } else {
      run = await this.transition(
        userId,
        runId,
        'running',
        membership.tenantId,
      );
    }
    await this.tenants.audit({
      tenantId: membership.tenantId,
      userId,
      action: 'agent.run.approve',
      resourceType: 'agent_run',
      resourceId: runId,
      outcome: 'success',
    });
    return run;
  }

  async cancel(userId: string, runId: string, tenantId?: string) {
    const current = await this.get(userId, runId, tenantId);
    if (this.dispatcher.isEnabled()) {
      const execution = await this.dispatcher.signalExecution(
        current.id,
        current.tenantId,
        'cancel',
      );
      if (
        execution.run_id !== current.id ||
        execution.tenant_id !== current.tenantId ||
        execution.status !== 'cancelled'
      ) {
        throw new Error('Agent cancellation returned an invalid snapshot');
      }
      return this.prisma.agentRun.update({
        where: { id: current.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }
    return this.transition(userId, runId, 'cancelled', current.tenantId);
  }

  async createPreferenceMemory(
    userId: string,
    input: CreateAgentMemoryDto,
    tenantId?: string,
  ) {
    const prohibited = [...new Set(findProhibitedRawHealthFields(input.value))];
    if (prohibited.length > 0) {
      throw new BadRequestException(
        `Raw health fields are not accepted: ${prohibited.sort().join(', ')}`,
      );
    }
    const membership = await this.tenants.getMembership(userId, tenantId);
    return this.dispatcher.createPreferenceMemory({
      tenantId: membership.tenantId,
      userId,
      preferenceKey: input.preferenceKey,
      value: input.value,
      source: input.source,
      purpose: input.purpose,
      consentId: input.consentId,
      expiresAt: input.expiresAt,
    });
  }

  async listPreferenceMemories(userId: string, tenantId?: string) {
    const membership = await this.tenants.getMembership(userId, tenantId);
    return this.dispatcher.listPreferenceMemories(membership.tenantId, userId);
  }

  async deletePreferenceMemory(
    userId: string,
    memoryId: string,
    tenantId?: string,
  ) {
    const membership = await this.tenants.getMembership(userId, tenantId);
    return this.dispatcher.deletePreferenceMemory(
      memoryId,
      membership.tenantId,
      userId,
    );
  }
}
