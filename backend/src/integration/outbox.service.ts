import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface DomainEvent {
  tenantId?: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  enqueue(event: DomainEvent, transaction?: Prisma.TransactionClient) {
    const client = transaction || this.prisma;
    return client.outboxEvent.create({
      data: {
        tenantId: event.tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion || 1,
        payload: event.payload as Prisma.InputJsonObject,
      },
    });
  }

  async claimBatch(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        tenantId: string | null;
        aggregateType: string;
        aggregateId: string;
        eventType: string;
        schemaVersion: number;
        payload: Prisma.JsonValue;
        attempts: number;
      }>
    >(
      `UPDATE outbox_events
       SET status = 'publishing', attempts = attempts + 1, updated_at = NOW()
       WHERE outbox_event_id IN (
         SELECT outbox_event_id
         FROM outbox_events
         WHERE status IN ('pending', 'retry') AND available_at <= NOW()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING
         outbox_event_id AS "id",
         tenant_id AS "tenantId",
         aggregate_type AS "aggregateType",
         aggregate_id AS "aggregateId",
         event_type AS "eventType",
         schema_version AS "schemaVersion",
         payload,
         attempts`,
      boundedLimit,
    );
  }

  async claimBatchByType(eventType: string, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    return this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        tenantId: string | null;
        aggregateId: string;
        eventType: string;
        payload: Prisma.JsonValue;
        attempts: number;
      }>
    >(
      `UPDATE outbox_events
       SET status = 'publishing', attempts = attempts + 1, updated_at = NOW()
       WHERE outbox_event_id IN (
         SELECT outbox_event_id FROM outbox_events
         WHERE event_type = $1 AND status IN ('pending', 'retry') AND available_at <= NOW()
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       RETURNING outbox_event_id AS "id", tenant_id AS "tenantId", aggregate_id AS "aggregateId",
         event_type AS "eventType", payload, attempts`,
      eventType,
      boundedLimit,
    );
  }

  markPublished(id: string) {
    return this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: new Date(),
        lastError: null,
      },
    });
  }

  markFailed(id: string, attempts: number, error: unknown) {
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    return this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: attempts >= 10 ? 'dead_letter' : 'retry',
        availableAt: new Date(Date.now() + delaySeconds * 1000),
        lastError:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : String(error).slice(0, 2000),
      },
    });
  }
}
