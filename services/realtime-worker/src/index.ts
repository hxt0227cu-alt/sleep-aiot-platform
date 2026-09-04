import { createServer, Server } from "http";
import { createClient } from "@clickhouse/client";
import type { ValidateFunction } from "ajv";
import { Kafka, logLevel, Partitioners } from "kafkajs";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { partitionNewEvents } from "./deduplication";
import { buildDeadLetterRecord } from "./dead-letter";
import { RecentEventIdCache } from "./recent-event-cache";
import { isWorkerReady } from "./readiness";
import {
  parseSchemaCoordinates,
  SchemaRegistryLookupError,
  SchemaRegistryResolver,
} from "./schema-registry";
import {
  decodeTelemetryEvent,
  PoisonKind,
  validateDevicePartitionKey,
} from "./telemetry-event";
import { toClickHouseDateTime64 } from "./timestamp";

const brokers = required("KAFKA_BROKERS").split(",");
const topic = process.env.KAFKA_TELEMETRY_TOPIC || "telemetry.device.v1";
const deadLetterTopic =
  process.env.KAFKA_TELEMETRY_DLQ_TOPIC || "telemetry.device.v1.dlq";
const groupId = process.env.KAFKA_GROUP_ID || "realtime-clickhouse-v1";
const metricsPort = Number(process.env.METRICS_PORT || 9103);
const kafkaSessionTimeoutMs = Number(
  process.env.KAFKA_SESSION_TIMEOUT_MS || 30_000,
);
const kafkaHeartbeatIntervalMs = Number(
  process.env.KAFKA_HEARTBEAT_INTERVAL_MS || 3_000,
);
if (
  !Number.isFinite(kafkaSessionTimeoutMs) ||
  !Number.isFinite(kafkaHeartbeatIntervalMs) ||
  kafkaSessionTimeoutMs <= 0 ||
  kafkaHeartbeatIntervalMs <= 0 ||
  kafkaHeartbeatIntervalMs >= kafkaSessionTimeoutMs
) {
  throw new Error(
    "Kafka heartbeat interval must be positive and lower than session timeout",
  );
}
const schemaRegistrySubject =
  process.env.SCHEMA_REGISTRY_SUBJECT || "telemetry.device.v1-value";
const schemaResolver = new SchemaRegistryResolver(
  required("SCHEMA_REGISTRY_URL"),
  schemaRegistrySubject,
  Number(process.env.SCHEMA_REGISTRY_CACHE_MAX_ENTRIES || 100),
  Number(process.env.SCHEMA_REGISTRY_TIMEOUT_MS || 5_000),
);
const maxDeadLetterPayloadBytes = Number(
  process.env.DLQ_MAX_PAYLOAD_BYTES || 256 * 1024,
);
const clickhouse = createClient({
  url: required("CLICKHOUSE_URL"),
  username: required("CLICKHOUSE_USER"),
  password: required("CLICKHOUSE_PASSWORD"),
  database: process.env.CLICKHOUSE_DB || "default",
  request_timeout: 30_000,
});

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "sleep_realtime_" });
const events = new Counter({
  name: "sleep_realtime_events_total",
  help: "Telemetry events by processing outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const batches = new Histogram({
  name: "sleep_realtime_batch_write_duration_seconds",
  help: "ClickHouse batch write duration",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const deadLetterDuration = new Histogram({
  name: "sleep_realtime_dlq_publish_duration_seconds",
  help: "Kafka dead-letter publication latency",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});
const ready = new Gauge({
  name: "sleep_realtime_ready",
  help: "Whether Kafka consumption and ClickHouse are ready",
  registers: [registry],
});
const schemaRegistryReady = new Gauge({
  name: "sleep_realtime_schema_registry_ready",
  help: "Whether the most recent required Schema Registry lookup succeeded",
  registers: [registry],
});
const schemaRegistryInfo = new Gauge({
  name: "sleep_realtime_schema_registry_info",
  help: "Preloaded internal event Schema identity",
  labelNames: ["subject", "schema_id", "schema_version"] as const,
  registers: [registry],
});
const schemaResolutions = new Counter({
  name: "sleep_realtime_schema_resolutions_total",
  help: "Schema resolution attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const schemaCacheEntries = new Gauge({
  name: "sleep_realtime_schema_cache_entries",
  help: "Number of compiled validators in the bounded Schema cache",
  registers: [registry],
});
const assignedPartitions = new Gauge({
  name: "sleep_realtime_consumer_assigned_partitions",
  help: "Number of Kafka partitions currently assigned to this Worker",
  registers: [registry],
});
const consumerGroupEvents = new Counter({
  name: "sleep_realtime_consumer_group_events_total",
  help: "Kafka consumer-group lifecycle events",
  labelNames: ["event"] as const,
  registers: [registry],
});
const consumerGroupJoinDuration = new Histogram({
  name: "sleep_realtime_consumer_group_join_duration_seconds",
  help: "Kafka consumer-group join duration",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || "realtime-worker",
  brokers,
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({
  groupId,
  sessionTimeout: kafkaSessionTimeoutMs,
  heartbeatInterval: kafkaHeartbeatIntervalMs,
  maxBytesPerPartition: 5 * 1024 * 1024,
});
const deadLetterProducer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 1,
});
let isReady = false;
let groupJoined = false;
let processingBlocked = false;
let consumerConnected = false;
let producerConnected = false;
let shutdownPromise: Promise<void> | undefined;
const recentEventIds = new RecentEventIdCache(
  Number(process.env.IDEMPOTENCY_CACHE_TTL_MS || 15 * 60 * 1_000),
  Number(process.env.IDEMPOTENCY_CACHE_MAX_ENTRIES || 100_000),
);

async function start() {
  const preloadedSchema = await schemaResolver.preloadLatest();
  schemaRegistryReady.set(1);
  schemaCacheEntries.set(schemaResolver.size);
  schemaRegistryInfo.set(
    {
      subject: preloadedSchema.subject,
      schema_id: String(preloadedSchema.id),
      schema_version: String(preloadedSchema.version),
    },
    1,
  );
  await clickhouse.ping();
  const schemaCheck = await clickhouse.query({
    query: "SELECT event_id FROM raw.device_telemetry LIMIT 0",
    format: "JSONEachRow",
  });
  await schemaCheck.json();
  await deadLetterProducer.connect();
  producerConnected = true;
  await consumer.connect();
  consumerConnected = true;
  consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    if (shutdownPromise) return;
    assignedPartitions.set(
      Object.values(payload.memberAssignment).reduce(
        (total, partitions) => total + partitions.length,
        0,
      ),
    );
    consumerGroupEvents.inc({ event: "join" });
    consumerGroupJoinDuration.observe(payload.duration / 1_000);
    groupJoined = true;
    updateReadyState();
  });
  consumer.on(consumer.events.CRASH, () => {
    groupJoined = false;
    assignedPartitions.set(0);
    consumerGroupEvents.inc({ event: "crash" });
    updateReadyState();
    events.inc({ outcome: "consumer_crash" });
  });
  consumer.on(consumer.events.DISCONNECT, () => {
    groupJoined = false;
    assignedPartitions.set(0);
    consumerGroupEvents.inc({ event: "disconnect" });
    updateReadyState();
  });
  await consumer.subscribe({ topic, fromBeginning: true });

  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({
      batch,
      resolveOffset,
      heartbeat,
      isRunning,
      isStale,
    }) => {
      if (!isRunning() || isStale()) return;
      try {
        const pending: Array<{
          eventId: string;
          offset: string;
          row: Record<string, unknown>;
        }> = [];
        const poisoned: Array<{
          offset: string;
          key: string;
          record: ReturnType<typeof buildDeadLetterRecord>;
        }> = [];
        for (const message of batch.messages) {
          const headers = message.headers as Record<string, unknown> | undefined;
          const reject = (
            kind: PoisonKind,
            rejectionMessage: string,
            validationErrors?: unknown[],
          ) => {
            const record = buildDeadLetterRecord({
              topic: batch.topic,
              partition: batch.partition,
              offset: message.offset,
              timestamp: message.timestamp,
              key: message.key,
              value: message.value,
              headers,
              kind,
              message: rejectionMessage,
              validationErrors,
              maxPayloadBytes: maxDeadLetterPayloadBytes,
            });
            poisoned.push({
              offset: message.offset,
              key: record.deadLetterId,
              record,
            });
          };
          const schemaHeader = parseSchemaCoordinates(
            headers,
            schemaRegistrySubject,
          );
          if (!schemaHeader.ok) {
            schemaResolutions.inc({ outcome: "header_rejected" });
            reject("schema_header", schemaHeader.message);
            continue;
          }

          let validateTelemetry: ValidateFunction;
          try {
            const resolved = await schemaResolver.resolve(
              schemaHeader.coordinates,
            );
            validateTelemetry = resolved.validate;
            schemaRegistryReady.set(1);
            schemaCacheEntries.set(schemaResolver.size);
            schemaResolutions.inc({
              outcome: resolved.cacheHit ? "cache_hit" : "cache_miss",
            });
          } catch (error) {
            if (
              error instanceof SchemaRegistryLookupError &&
              !error.transient
            ) {
              schemaResolutions.inc({ outcome: "identity_rejected" });
              reject("unknown_schema", error.message);
              continue;
            }
            schemaRegistryReady.set(0);
            schemaResolutions.inc({ outcome: "registry_failure" });
            throw error;
          }

          const decoded = decodeTelemetryEvent(message.value, validateTelemetry);
          if (!decoded.ok) {
            reject(
              decoded.kind,
              decoded.message,
              decoded.validationErrors,
            );
            continue;
          }
          const event = decoded.event;
          const partitionKey = validateDevicePartitionKey(
            message.key,
            event.deviceId,
          );
          if (!partitionKey.ok) {
            reject(partitionKey.kind, partitionKey.message);
            continue;
          }
          pending.push({
            eventId: event.eventId,
            offset: message.offset,
            row: {
              event_id: event.eventId,
              tenant_id: event.tenantId,
              device_id: event.deviceId,
              schema_version: event.schemaVersion,
              occurred_at: toClickHouseDateTime64(event.occurredAt),
              received_at: toClickHouseDateTime64(event.receivedAt),
              sequence: event.sequence ?? 0,
              heart_rate: event.heartRate ?? null,
              breathing_rate: event.breathingRate ?? null,
              body_movement: event.bodyMovement ?? null,
              sleep_state: event.sleepState || "unknown",
              confidence: event.confidence ?? null,
            },
          });
        }

        if (pending.length > 0) {
          const existingResult = await clickhouse.query({
            query: `
            SELECT toString(event_id) AS event_id
            FROM raw.device_telemetry
            WHERE event_id IN (
              SELECT arrayJoin(
                arrayMap(value -> toUUID(value), {event_ids:Array(String)})
              )
            )
          `,
            query_params: { event_ids: pending.map((event) => event.eventId) },
            format: "JSONEachRow",
          });
          const existingRows = await existingResult.json<{
            event_id: string;
          }>();
          const existingEventIds = new Set(
            existingRows.map((row) => row.event_id),
          );
          for (const event of pending) {
            if (recentEventIds.has(event.eventId))
              existingEventIds.add(event.eventId);
          }
          const { accepted, duplicates } = partitionNewEvents(
            pending,
            existingEventIds,
          );

          for (const duplicate of duplicates) resolveOffset(duplicate.offset);
          if (duplicates.length > 0) {
            events.inc({ outcome: "duplicate" }, duplicates.length);
          }

          if (accepted.length > 0) {
            const end = batches.startTimer();
            await clickhouse.insert({
              table: "raw.device_telemetry",
              values: accepted.map((event) => event.row),
              format: "JSONEachRow",
            });
            end();
            events.inc({ outcome: "inserted" }, accepted.length);
            for (const event of accepted) {
              recentEventIds.add(event.eventId);
              resolveOffset(event.offset);
            }
          }
        }

        if (poisoned.length > 0) {
          const end = deadLetterDuration.startTimer();
          try {
            await deadLetterProducer.send({
              topic: deadLetterTopic,
              acks: -1,
              messages: poisoned.map(({ key, record }) => ({
                key,
                value: JSON.stringify(record),
                headers: {
                  deadLetterId: record.deadLetterId,
                  sourceTopic: batch.topic,
                  sourcePartition: String(batch.partition),
                },
              })),
            });
          } catch (error) {
            events.inc({ outcome: "dlq_publish_failed" }, poisoned.length);
            throw error;
          } finally {
            end();
          }
          for (const item of poisoned) resolveOffset(item.offset);
          events.inc({ outcome: "invalid_event" }, poisoned.length);
          events.inc({ outcome: "dead_lettered" }, poisoned.length);
        }

        await heartbeat();
        if (!isRunning() || isStale()) return;
        await consumer.commitOffsets([
          {
            topic: batch.topic,
            partition: batch.partition,
            offset: (BigInt(batch.lastOffset()) + 1n).toString(),
          },
        ]);
        processingBlocked = false;
        updateReadyState();
      } catch (error) {
        processingBlocked = true;
        updateReadyState();
        throw error;
      }
    },
  });
}

const server = createServer(async (request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": registry.contentType });
    response.end(await registry.metrics());
    return;
  }
  if (request.url === "/health/ready") {
    response.writeHead(isReady ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ready: isReady }));
    return;
  }
  response.writeHead(404).end();
}).listen(metricsPort);

function updateReadyState() {
  isReady = isWorkerReady({
    groupJoined,
    processingBlocked,
    shuttingDown: Boolean(shutdownPromise),
  });
  ready.set(isReady ? 1 : 0);
}

async function shutdown(signal: string) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    groupJoined = false;
    updateReadyState();
    console.info("Graceful shutdown started", { signal });

    if (consumerConnected) await consumer.stop();
    const disconnects: Promise<unknown>[] = [];
    if (consumerConnected) disconnects.push(consumer.disconnect());
    if (producerConnected) disconnects.push(deadLetterProducer.disconnect());
    await Promise.all(disconnects);
    consumerConnected = false;
    producerConnected = false;
    await clickhouse.close();
    await closeServer(server);
    console.info("Graceful shutdown completed", { signal });
  })();
  return shutdownPromise;
}

function closeServer(httpServer: Server) {
  return new Promise<void>((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      httpServer.closeAllConnections();
    }, 5_000);
    timeout.unref();
    httpServer.close((error) => {
      clearTimeout(timeout);
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
}

start().catch((error) => {
  groupJoined = false;
  processingBlocked = true;
  updateReadyState();
  console.error(error);
  process.exitCode = 1;
  void shutdown("startup-failure").catch((shutdownError) => {
    console.error("Startup cleanup failed", shutdownError);
  });
});
