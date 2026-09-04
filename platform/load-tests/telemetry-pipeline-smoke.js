import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const mqttUrl = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
const ingestMetricsUrl = process.env.INGEST_METRICS_URL || 'http://127.0.0.1:9102/metrics';
const workerMetricsUrl = process.env.WORKER_METRICS_URL || 'http://127.0.0.1:9103/metrics';
const schemaRegistryUrl = process.env.SCHEMA_REGISTRY_URL || 'http://127.0.0.1:8081';
const schemaRegistrySubject = process.env.SCHEMA_REGISTRY_SUBJECT || 'telemetry.device.v1-value';
const clickhouseUrl = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const clickhouseUser = process.env.CLICKHOUSE_USER || 'sleep';
const clickhousePassword = required('CLICKHOUSE_PASSWORD');
const runId = process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, '-');
const tenantId = `tenant-e2e-${runId}`;
const deviceId = `device-e2e-${runId}`;
const topic = `device/${deviceId}/telemetry`;

const outcomes = {
  ingest: ['published', 'schema_rejected', 'invalid_json'],
  worker: ['inserted', 'duplicate', 'invalid_event'],
  workerSchema: ['cache_hit', 'cache_miss', 'header_rejected', 'identity_rejected', 'registry_failure'],
};

async function main() {
  await requireReady('telemetry-ingest', ingestMetricsUrl.replace('/metrics', '/health/ready'));
  await requireReady('realtime-worker', workerMetricsUrl.replace('/metrics', '/health/ready'));

  const schemaIdentity = await latestSchemaIdentity();
  const before = await metricSnapshot();
  const now = Date.now();
  const normalId = randomUUID();
  const outOfOrderId = randomUUID();
  const lateId = randomUUID();
  const rejectedId = randomUUID();
  const normal = event(normalId, 100, new Date(now - 5_000).toISOString());
  const outOfOrder = event(outOfOrderId, 99, new Date(now - 4_000).toISOString());
  const late = event(lateId, 101, new Date(now - 2 * 60 * 60 * 1_000).toISOString());
  const rejected = { ...event(rejectedId, 102, new Date(now).toISOString()), heartRate: 999 };

  const client = await mqtt.connectAsync(mqttUrl, {
    clientId: `telemetry-e2e-${runId}`.slice(0, 120),
    clean: true,
    reconnectPeriod: 0,
  });
  try {
    await publish(client, topic, JSON.stringify(normal));
    await publish(client, topic, JSON.stringify(normal));
    await publish(client, topic, JSON.stringify(outOfOrder));
    await publish(client, topic, JSON.stringify(late));
    await publish(client, topic, JSON.stringify(rejected));
    await publish(client, topic, '{not-json');
  } finally {
    await client.endAsync();
  }

  const eventIds = [normalId, outOfOrderId, lateId];
  const rows = await pollRows(eventIds, 3, 30_000);
  const after = await metricSnapshot();
  const delta = metricDelta(before, after);
  const duplicateRows = rows.filter((row) => row.event_id === normalId).length;
  const sequences = rows.map((row) => Number(row.sequence));

  const assertions = {
    unique_rows: rows.length === 3,
    duplicate_written_once: duplicateRows === 1,
    sequences_preserved: [99, 100, 101].every((sequence) => sequences.includes(sequence)),
    ingest_published_four: delta.ingest.published === 4,
    schema_rejected_one: delta.ingest.schema_rejected === 1,
    invalid_json_one: delta.ingest.invalid_json === 1,
    worker_inserted_three: delta.worker.inserted === 3,
    worker_duplicate_one: delta.worker.duplicate === 1,
    worker_invalid_zero: delta.worker.invalid_event === 0,
    worker_schema_cache_hits_four: delta.workerSchema.cache_hit === 4,
    worker_schema_cache_miss_zero: delta.workerSchema.cache_miss === 0,
    worker_schema_header_rejected_zero: delta.workerSchema.header_rejected === 0,
    worker_schema_identity_rejected_zero: delta.workerSchema.identity_rejected === 0,
    worker_schema_registry_failure_zero: delta.workerSchema.registry_failure === 0,
  };
  const result = {
    evidenceType: 'local-integration-smoke',
    runId,
    startedAt: new Date(now).toISOString(),
    finishedAt: new Date().toISOString(),
    topology: 'MQTT -> telemetry-ingest -> Kafka -> realtime-worker -> ClickHouse',
    scenarios: ['valid', 'duplicate', 'out_of_order_sequence', 'two_hour_late', 'schema_rejected', 'invalid_json'],
    identifiers: { tenantId, deviceId, eventIds, rejectedId },
    schemaIdentity,
    metricDelta: delta,
    rows,
    assertions,
    passed: Object.values(assertions).every(Boolean),
    evidenceBoundary: 'Synthetic local integration evidence; not a throughput or production-capacity result.',
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

function event(eventId, sequence, occurredAt) {
  return {
    eventId,
    schemaVersion: 1,
    tenantId,
    deviceId,
    occurredAt,
    sequence,
    heartRate: 62,
    breathingRate: 14,
    bodyMovement: 0.2,
    sleepState: 'deep',
    confidence: 0.94,
  };
}

async function publish(client, targetTopic, payload) {
  await client.publishAsync(targetTopic, payload, { qos: 1 });
}

async function requireReady(name, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} is not ready: ${response.status} ${await response.text()}`);
}

async function metricSnapshot() {
  const [ingest, worker, workerSchema] = await Promise.all([
    readOutcomes(ingestMetricsUrl, 'sleep_ingest_messages_total', outcomes.ingest),
    readOutcomes(workerMetricsUrl, 'sleep_realtime_events_total', outcomes.worker),
    readOutcomes(
      workerMetricsUrl,
      'sleep_realtime_schema_resolutions_total',
      outcomes.workerSchema,
    ),
  ]);
  return { ingest, worker, workerSchema };
}

async function latestSchemaIdentity() {
  const url = `${schemaRegistryUrl.replace(/\/+$/, '')}/subjects/${encodeURIComponent(schemaRegistrySubject)}/versions/latest`;
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.schemaregistry.v1+json' },
  });
  if (!response.ok) throw new Error(`Schema Registry lookup failed: ${response.status} ${await response.text()}`);
  const value = await response.json();
  return { subject: value.subject, id: value.id, version: value.version, schemaType: value.schemaType };
}

async function readOutcomes(url, metricName, labels) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`metrics request failed: ${response.status} ${url}`);
  const body = await response.text();
  const values = Object.fromEntries(labels.map((label) => [label, 0]));
  for (const line of body.split('\n')) {
    const match = line.match(new RegExp(`^${metricName}\\{outcome="([^"]+)"\\} ([0-9.eE+-]+)$`));
    if (match && match[1] in values) values[match[1]] = Number(match[2]);
  }
  return values;
}

function metricDelta(before, after) {
  return Object.fromEntries(
    Object.keys(after).map((service) => [
      service,
      Object.fromEntries(
        Object.keys(after[service]).map((outcome) => [
          outcome,
          after[service][outcome] - before[service][outcome],
        ]),
      ),
    ]),
  );
}

async function pollRows(eventIds, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await queryRows(eventIds);
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`ClickHouse did not expose ${expected} unique events within ${timeoutMs} ms`);
}

async function queryRows(eventIds) {
  const quoted = eventIds.map((id) => `'${id}'`).join(',');
  const query = `
    SELECT
      toString(event_id) AS event_id,
      tenant_id,
      device_id,
      sequence,
      occurred_at,
      received_at,
      dateDiff('millisecond', occurred_at, received_at) AS ingest_delay_ms
    FROM raw.device_telemetry
    WHERE event_id IN (${quoted})
    ORDER BY sequence
    FORMAT JSONEachRow
  `;
  const response = await fetch(clickhouseUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
      'content-type': 'text/plain',
    },
    body: query,
  });
  if (!response.ok) throw new Error(`ClickHouse query failed: ${response.status} ${await response.text()}`);
  const body = (await response.text()).trim();
  return body ? body.split('\n').map((line) => JSON.parse(line)) : [];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
