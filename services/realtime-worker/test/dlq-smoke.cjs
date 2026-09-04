const { createHash, randomUUID } = require('node:crypto');
const { Kafka, logLevel, Partitioners } = require('kafkajs');

const brokers = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const sourceTopic = process.env.KAFKA_TELEMETRY_TOPIC || 'telemetry.device.v1';
const deadLetterTopic = process.env.KAFKA_TELEMETRY_DLQ_TOPIC || 'telemetry.device.v1.dlq';
const clickhouseUrl = process.env.CLICKHOUSE_URL || 'http://clickhouse:8123';
const clickhouseUser = process.env.CLICKHOUSE_USER || 'sleep';
const clickhousePassword = required('CLICKHOUSE_PASSWORD');
const workerMetricsUrl = process.env.WORKER_METRICS_URL || 'http://realtime-worker:9103/metrics';
const schemaRegistryUrl = process.env.SCHEMA_REGISTRY_URL || 'http://schema-registry:8081';
const schemaSubject = process.env.SCHEMA_REGISTRY_SUBJECT || 'telemetry.device.v1-value';
const runId = process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, '-');
const tenantId = `tenant-dlq-${runId}`;
const deviceId = `device-dlq-${runId}`;
const validEventId = randomUUID();
const invalidSchemaEventId = randomUUID();
const missingHeaderEventId = randomUUID();
const mismatchedIdEventId = randomUUID();
const crossSubjectEventId = randomUUID();

const kafka = new Kafka({
  clientId: `dlq-smoke-${runId}`.slice(0, 120),
  brokers,
  logLevel: logLevel.NOTHING,
});
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
});
const consumer = kafka.consumer({
  groupId: `dlq-smoke-${runId}`.slice(0, 220),
});

async function main() {
  const startedAt = new Date().toISOString();
  const schema = await latestSchema();
  const before = await readWorkerMetrics();
  const deadLetters = [];

  await consumer.connect();
  await consumer.subscribe({ topic: deadLetterTopic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const record = JSON.parse(message.value.toString('utf8'));
      if (record.tenantId === tenantId) deadLetters.push(record);
    },
  });
  await producer.connect();

  const now = new Date().toISOString();
  const valid = telemetryEvent(validEventId, now);
  const invalidSchema = { ...telemetryEvent(invalidSchemaEventId, now), heartRate: 999 };
  const cases = [
    { name: 'valid', value: Buffer.from(JSON.stringify(valid)), traceId: validEventId },
    { name: 'invalid_json', value: Buffer.from('{broken'), traceId: randomUUID() },
    { name: 'schema_validation', value: Buffer.from(JSON.stringify(invalidSchema)), traceId: invalidSchemaEventId },
    { name: 'null_value', value: null, traceId: randomUUID() },
    {
      name: 'missing_schema_header',
      value: Buffer.from(JSON.stringify(telemetryEvent(missingHeaderEventId, now))),
      traceId: missingHeaderEventId,
      headerMode: 'missing',
    },
    {
      name: 'mismatched_schema_id',
      value: Buffer.from(JSON.stringify(telemetryEvent(mismatchedIdEventId, now))),
      traceId: mismatchedIdEventId,
      schemaId: schema.id + 1000000,
    },
    {
      name: 'cross_subject',
      value: Buffer.from(JSON.stringify(telemetryEvent(crossSubjectEventId, now))),
      traceId: crossSubjectEventId,
      schemaSubject: 'forbidden.telemetry-value',
    },
  ];
  const publications = [];

  try {
    for (const item of cases) {
      const headers = {
        tenantId,
        traceId: item.traceId,
        contractVersion: '1',
        schemaId: String(item.schemaId || schema.id),
        schemaSubject: item.schemaSubject || schema.subject,
        schemaVersion: String(schema.version),
      };
      if (item.headerMode === 'missing') {
        delete headers.schemaId;
        delete headers.schemaSubject;
        delete headers.schemaVersion;
      }
      const metadata = await producer.send({
        topic: sourceTopic,
        acks: -1,
        messages: [{
          key: deviceId,
          value: item.value,
          headers,
        }],
      });
      publications.push({ name: item.name, partition: metadata[0].partition, offset: metadata[0].baseOffset });
    }

    await poll(async () => deadLetters.length === 6, 30_000, 'six dead-letter records');
    await poll(async () => (await queryEventCount(validEventId)) === 1, 30_000, 'valid ClickHouse row');
    await poll(async () => {
      const metrics = await readWorkerMetrics();
      return metricDelta(before, metrics, 'dead_lettered') >= 6;
    }, 30_000, 'dead-letter metric');

    const after = await readWorkerMetrics();
    const kindCounts = deadLetters.reduce((counts, record) => {
      counts[record.error.kind] = (counts[record.error.kind] || 0) + 1;
      return counts;
    }, {});
    const deterministicIds = deadLetters.every((record) => {
      const source = record.source;
      const expected = createHash('sha256')
        .update(`${source.topic}\u0000${source.partition}\u0000${source.offset}`)
        .digest('hex');
      return record.deadLetterId === expected;
    });
    const sourceOffsets = new Set(publications.slice(1).map((item) => `${item.partition}:${item.offset}`));
    const dlqOffsets = new Set(deadLetters.map((record) => `${record.source.partition}:${record.source.offset}`));
    const assertions = {
      valid_inserted_once: (await queryEventCount(validEventId)) === 1,
      invalid_schema_not_inserted: (await queryEventCount(invalidSchemaEventId)) === 0,
      invalid_schema_identity_events_not_inserted:
        (await queryEventCount(missingHeaderEventId)) === 0 &&
        (await queryEventCount(mismatchedIdEventId)) === 0 &&
        (await queryEventCount(crossSubjectEventId)) === 0,
      exactly_six_dead_letters: deadLetters.length === 6,
      poison_kinds_preserved:
        kindCounts.invalid_json === 1 &&
        kindCounts.null_value === 1 &&
        kindCounts.schema_validation === 1 &&
        kindCounts.schema_header === 2 &&
        kindCounts.unknown_schema === 1,
      source_offsets_preserved: setsEqual(sourceOffsets, dlqOffsets),
      deterministic_dead_letter_ids: deterministicIds,
      tenant_dimension_preserved: deadLetters.every((record) => record.tenantId === tenantId),
      invalid_metric_six: metricDelta(before, after, 'invalid_event') === 6,
      dead_letter_metric_six: metricDelta(before, after, 'dead_lettered') === 6,
      dlq_publish_failures_zero: metricDelta(before, after, 'dlq_publish_failed') === 0,
    };
    const result = {
      evidenceType: 'local-dlq-integration-smoke',
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      topology: 'Kafka source -> realtime-worker -> ClickHouse + Kafka DLQ',
      identifiers: {
        tenantId,
        deviceId,
        validEventId,
        invalidSchemaEventId,
        missingHeaderEventId,
        mismatchedIdEventId,
        crossSubjectEventId,
      },
      schema: { subject: schema.subject, id: schema.id, version: schema.version },
      publications,
      metricDelta: {
        inserted: metricDelta(before, after, 'inserted'),
        invalid_event: metricDelta(before, after, 'invalid_event'),
        dead_lettered: metricDelta(before, after, 'dead_lettered'),
        dlq_publish_failed: metricDelta(before, after, 'dlq_publish_failed'),
      },
      deadLetters,
      assertions,
      passed: Object.values(assertions).every(Boolean),
      evidenceBoundary: 'Synthetic local single-broker integration evidence; not multi-broker durability or production-capacity proof.',
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await producer.disconnect();
    await consumer.disconnect();
  }
}

async function latestSchema() {
  const response = await fetch(
    `${schemaRegistryUrl.replace(/\/+$/, '')}/subjects/${encodeURIComponent(schemaSubject)}/versions/latest`,
    { headers: { accept: 'application/vnd.schemaregistry.v1+json' } },
  );
  if (!response.ok) {
    throw new Error(`Schema Registry lookup failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function telemetryEvent(eventId, timestamp) {
  return {
    eventType: 'device.telemetry.received',
    eventId,
    traceId: eventId,
    schemaVersion: 1,
    tenantId,
    deviceId,
    occurredAt: timestamp,
    receivedAt: timestamp,
    sequence: 1,
    heartRate: 62,
    breathingRate: 14,
    bodyMovement: 0.2,
    sleepState: 'deep',
    confidence: 0.94,
  };
}

async function readWorkerMetrics() {
  const response = await fetch(workerMetricsUrl);
  if (!response.ok) throw new Error(`Worker metrics failed: ${response.status}`);
  const body = await response.text();
  const values = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^sleep_realtime_events_total\{outcome="([^"]+)"\} ([0-9.eE+-]+)$/);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

function metricDelta(before, after, outcome) {
  return (after[outcome] || 0) - (before[outcome] || 0);
}

async function queryEventCount(eventId) {
  const query = `SELECT count() FROM raw.device_telemetry WHERE event_id = '${eventId}'`;
  const response = await fetch(clickhouseUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
      'content-type': 'text/plain',
    },
    body: query,
  });
  if (!response.ok) throw new Error(`ClickHouse query failed: ${response.status} ${await response.text()}`);
  return Number((await response.text()).trim());
}

async function poll(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
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
