import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox.service';

type AgentRequestedPayload = {
  runId: string;
  tenantId: string;
  userId: string;
  agentType: string;
  workflowVersion: string;
  input: Record<string, unknown>;
  correlationId?: string;
};

export interface AgentExecutionSnapshot {
  run_id: string;
  tenant_id: string;
  status: string;
  output?: Record<string, unknown> | null;
  error?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
}

export interface AgentPreferenceMemorySnapshot {
  memory_id: string;
  tenant_id: string;
  user_id: string;
  preference_key: string;
  value: Record<string, unknown>;
  expires_at: string;
}

@Injectable()
export class AgentDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentDispatcherService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) return;
    this.timer = setInterval(() => void this.dispatchPending(), 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  isEnabled() {
    return this.config.get('AGENT_DISPATCH_ENABLED') === 'true';
  }

  async getExecution(runId: string, tenantId: string) {
    const baseUrl =
      this.config.get<string>('AGENT_SERVICE_URL') || 'http://127.0.0.1:8100';
    const response = await fetch(`${baseUrl}/v1/runs/${runId}`, {
      headers: { 'x-tenant-id': tenantId },
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Agent service returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    return payload as AgentExecutionSnapshot;
  }

  async signalExecution(
    runId: string,
    tenantId: string,
    action: 'approve' | 'cancel',
  ) {
    const baseUrl =
      this.config.get<string>('AGENT_SERVICE_URL') || 'http://127.0.0.1:8100';
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/${action}`, {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `Agent service ${action} returned HTTP ${response.status}`,
      );
    }
    return (await response.json()) as AgentExecutionSnapshot;
  }

  async createPreferenceMemory(params: {
    tenantId: string;
    userId: string;
    preferenceKey: string;
    value: Record<string, unknown>;
    source: string;
    purpose: string;
    consentId: string;
    expiresAt: string;
  }): Promise<AgentPreferenceMemorySnapshot> {
    const response = await this.memoryRequest('/v1/memories/preferences', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: params.tenantId,
        user_id: params.userId,
        preference_key: params.preferenceKey,
        value: params.value,
        source: params.source,
        purpose: params.purpose,
        consent_id: params.consentId,
        expires_at: params.expiresAt,
      }),
      tenantId: params.tenantId,
      userId: params.userId,
    });
    return this.validateMemorySnapshot(
      response,
      params.tenantId,
      params.userId,
    );
  }

  async listPreferenceMemories(tenantId: string, userId: string) {
    const response = await this.memoryRequest('/v1/memories/preferences', {
      method: 'GET',
      tenantId,
      userId,
    });
    if (!Array.isArray(response)) {
      throw new Error('Agent memory service returned an invalid list');
    }
    return response.map((item) =>
      this.validateMemorySnapshot(item, tenantId, userId),
    );
  }

  async deletePreferenceMemory(
    memoryId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    await this.memoryRequest(`/v1/memories/preferences/${memoryId}`, {
      method: 'DELETE',
      tenantId,
      userId,
    });
  }

  private async memoryRequest(
    path: string,
    params: {
      method: 'GET' | 'POST' | 'DELETE';
      tenantId: string;
      userId: string;
      body?: string;
    },
  ): Promise<unknown> {
    const baseUrl =
      this.config.get<string>('AGENT_SERVICE_URL') || 'http://127.0.0.1:8100';
    const response = await fetch(`${baseUrl}${path}`, {
      method: params.method,
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': params.tenantId,
        'x-user-id': params.userId,
      },
      ...(params.body ? { body: params.body } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Agent memory service returned HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return (await response.json()) as unknown;
  }

  private validateMemorySnapshot(
    value: unknown,
    tenantId: string,
    userId: string,
  ): AgentPreferenceMemorySnapshot {
    if (!value || typeof value !== 'object') {
      throw new Error('Agent memory service returned an invalid snapshot');
    }
    const snapshot = value as Partial<AgentPreferenceMemorySnapshot>;
    if (
      snapshot.tenant_id !== tenantId ||
      snapshot.user_id !== userId ||
      typeof snapshot.memory_id !== 'string' ||
      typeof snapshot.preference_key !== 'string' ||
      !snapshot.value ||
      typeof snapshot.value !== 'object' ||
      typeof snapshot.expires_at !== 'string'
    ) {
      throw new Error('Agent memory service returned an invalid snapshot');
    }
    return snapshot as AgentPreferenceMemorySnapshot;
  }

  async dispatchPending() {
    const events = await this.outbox.claimBatchByType(
      'agent.run.requested',
      20,
    );
    for (const event of events) {
      try {
        await this.dispatch(event.payload as unknown as AgentRequestedPayload);
        await this.outbox.markPublished(event.id);
      } catch (error) {
        await this.outbox.markFailed(event.id, event.attempts, error);
        this.logger.warn(
          `Agent run ${event.aggregateId} dispatch failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return events.length;
  }

  async dispatch(payload: AgentRequestedPayload) {
    const correlationId = payload.correlationId || payload.runId;
    const startedAt = Date.now();
    const baseUrl =
      this.config.get<string>('AGENT_SERVICE_URL') || 'http://127.0.0.1:8100';
    const response = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        run_id: payload.runId,
        tenant_id: payload.tenantId,
        user_id: payload.userId,
        agent_type: payload.agentType,
        workflow_version: payload.workflowVersion,
        input: payload.input,
        correlation_id: correlationId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Agent service returned HTTP ${response.status}`);
    this.logger.log(
      JSON.stringify({
        event: 'agent.dispatch.completed',
        runId: payload.runId,
        tenantId: payload.tenantId,
        correlationId,
        agentType: payload.agentType,
        durationMs: Date.now() - startedAt,
      }),
    );
    return (await response.json()) as unknown;
  }
}
