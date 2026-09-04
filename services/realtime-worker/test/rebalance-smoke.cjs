const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const {
  Kafka,
  logLevel,
  Partitioners,
} = require('kafkajs');

const runId = process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, '-');
const partitionCount = numberEnv('PARTITION_COUNT', 12);
const warmupEvents = numberEnv('WARMUP_EVENTS', 240);
const loadEvents = numberEnv('LOAD_EVENTS', 6000);
const replayEvents = numberEnv('REPLAY_EVENTS', 100);
const killAfterEvents = numberEnv('KILL_AFTER_EVENTS', 1000);
const sourceTopic = `telemetry.rebalance.${runId}`.slice(0, 220);
const deadLetterTopic = `${sourceTopic}.dlq`.slice(0, 240);
const groupId = `realtime-rebalance-${runId}`.slice(0, 220);
const tenantId = `tenant-rebalance-${runId}`.slice(0, 120);
const workerImage = process.env.WORKER_IMAGE || 'local-realtime-worker';
const dockerNetwork = process.env.DOCKER_NETWORK || 'local_default';
const hostBrokers = (process.env.KAFKA_BROKERS || '127.0.0.1:29092').split(',');
const workerBrokers = process.env.WORKER_KAFKA_BROKERS || 'kafka:9092';
const hostSchemaRegistryUrl = process.env.SCHEMA_REGISTRY_URL || 'http://127.0.0.1:8081';
const workerSchemaRegistryUrl = process.env.WORKER_SCHEMA_REGISTRY_URL || 'http://schema-registry:8081';
const schemaSubject = process.env.SCHEMA_REGISTRY_SUBJECT || 'telemetry.device.v1-value';
const hostClickHouseUrl = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const workerClickHouseUrl = process.env.WORKER_CLICKHOUSE_URL || 'http://clickhouse:8123';
const clickHouseUser = process.env.CLICKHOUSE_USER || 'sleep';
const clickHousePassword = required('CLICKHOUSE_PASSWORD');
const clickHouseDb = process.env.CLICKHOUSE_DB || 'sleep_warehouse';
const kafkaSessionTimeoutMs = numberEnv('KAFKA_SESSION_TIMEOUT_MS', 10_000);
const kafkaHeartbeatIntervalMs = numberEnv('KAFKA_HEARTBEAT_INTERVAL_MS', 2_000);
const workerNames = [
  `rebalance-worker-a-${runId}`.slice(0, 120),
  `rebalance-worker-b-${runId}`.slice(0, 120),
];
const startedContainers = [];

const kafka = new Kafka({
  clientId: `rebalance-evidence-${runId}`.slice(0, 120),
  brokers: hostBrokers,
  logLevel: logLevel.NOTHING,
});
const admin = kafka.admin();
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 1,
});
const dlqConsumer = kafka.consumer({
  groupId: `rebalance-dlq-observer-${runId}`.slice(0, 220),
});

let adminConnected = false;
let producerConnected = false;
let dlqConsumerConnected = false;
let topicsCreated = false;
let passed = false;

async function main() {
  const startedAt = new Date().toISOString();
  const schema = await latestSchema();
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', workerImage]).trim();
  const eventIds = [];
  const replayCandidates = [];
  const deadLetters = [];
  let workerUrls;
  let beforeFailure;
  let afterFailure;
  let lagAfterFailure;
  let finalLag;
  let recoveryMs;
  let invalidEventId;

  try {
    await admin.connect();
    adminConnected = true;
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: sourceTopic, numPartitions: partitionCount, replicationFactor: 1 },
        {
          topic: deadLetterTopic,
          numPartitions: partitionCount,
          replicationFactor: 1,
          configEntries: [{ name: 'retention.ms', value: '604800000' }],
        },
      ],
    });
    topicsCreated = true;

    workerUrls = workerNames.map((name, index) => startWorker(name, index));
    const balanced = await poll(
      async () => {
        const [workerA, workerB, group] = await Promise.all([
          readWorkerMetrics(workerUrls[0]).catch(() => null),
          readWorkerMetrics(workerUrls[1]).catch(() => null),
          describeGroup().catch(() => null),
        ]);
        if (
          workerA?.ready &&
          workerB?.ready &&
          workerA.assignedPartitions > 0 &&
          workerB.assignedPartitions > 0 &&
          workerA.assignedPartitions + workerB.assignedPartitions === partitionCount &&
          group?.state === 'Stable' &&
          group.memberCount === 2
        ) {
          return { workerA, workerB, group };
        }
        return null;
      },
      90_000,
      'two Workers with a complete partition assignment',
    );

    await producer.connect();
    producerConnected = true;
    const warmup = buildEvents(warmupEvents, eventIds.length, schema, eventIds);
    replayCandidates.push(...warmup.slice(0, replayEvents));
    await publishBatches(warmup, 200);
    await poll(
      async () => ((await groupLag()).totalLag === 0 ? true : null),
      60_000,
      'warm-up lag to drain',
    );
    const warmMetrics = await Promise.all(workerUrls.map(readWorkerMetrics));
    if (!warmMetrics.every((metrics) => metrics.inserted > 0)) {
      throw new Error('Both Workers must process warm-up records before failure injection');
    }

    const load = buildEvents(loadEvents, eventIds.length, schema, eventIds);
    let published = 0;
    let killedAtMs;
    for (let index = 0; index < load.length; index += 200) {
      const batch = load.slice(index, index + 200);
      await publish(batch);
      published += batch.length;
      if (!killedAtMs && published >= killAfterEvents) {
        beforeFailure = {
          observedAt: new Date().toISOString(),
          workers: await Promise.all(workerUrls.map(readWorkerMetrics)),
          group: await describeGroup(),
          publishedLoadEvents: published,
        };
        killedAtMs = Date.now();
        docker(['kill', workerNames[0]]);
      }
      await delay(5);
    }
    if (!killedAtMs) throw new Error('Failure injection threshold was not reached');

    lagAfterFailure = await poll(
      async () => {
        const snapshot = await groupLag().catch(() => null);
        return snapshot && snapshot.totalLag > 0 ? snapshot : null;
      },
      20_000,
      'positive lag after abrupt Worker termination',
    );
    afterFailure = await poll(
      async () => {
        const [workerB, group] = await Promise.all([
          readWorkerMetrics(workerUrls[1]).catch(() => null),
          describeGroup().catch(() => null),
        ]);
        if (
          workerB?.ready &&
          workerB.assignedPartitions === partitionCount &&
          group?.state === 'Stable' &&
          group.memberCount === 1
        ) {
          return { observedAt: new Date().toISOString(), workerB, group };
        }
        return null;
      },
      60_000,
      'surviving Worker to own every partition',
    );
    recoveryMs = Date.now() - killedAtMs;

    finalLag = await poll(
      async () => {
        const snapshot = await groupLag();
        return snapshot.totalLag === 0 ? snapshot : null;
      },
      120_000,
      'post-failure lag to drain',
    );

    await publish(replayCandidates);
    invalidEventId = randomUUID();
    const invalidDeviceId = deviceIdFor(0);
    await publish([
      messageForEvent(
        telemetryEvent(invalidEventId, invalidDeviceId, eventIds.length, new Date().toISOString()),
        schema,
        0,
        'wrong-device-key',
      ),
    ]);

    await dlqConsumer.connect();
    dlqConsumerConnected = true;
    await dlqConsumer.subscribe({ topic: deadLetterTopic, fromBeginning: true });
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const record = JSON.parse(message.value.toString('utf8'));
        if (record.traceId === invalidEventId) deadLetters.push(record);
      },
    });

    finalLag = await poll(
      async () => {
        const snapshot = await groupLag();
        return snapshot.totalLag === 0 ? snapshot : null;
      },
      60_000,
      'replay and invalid-key records to commit',
    );
    await poll(
      async () => (deadLetters.length === 1 ? true : null),
      30_000,
      'partition-key DLQ record',
    );

    const [warehouse, invalidCount, survivorMetrics, finalGroup] = await Promise.all([
      queryTenantCounts(),
      queryEventCount(invalidEventId),
      readWorkerMetrics(workerUrls[1]),
      describeGroup(),
    ]);
    const expectedUniqueEvents = warmupEvents + loadEvents;
    const assertions = {
      two_members_before_failure: balanced.group.memberCount === 2,
      partitions_split_between_workers:
        balanced.workerA.assignedPartitions > 0 &&
        balanced.workerB.assignedPartitions > 0 &&
        balanced.workerA.assignedPartitions + balanced.workerB.assignedPartitions === partitionCount,
      both_workers_processed_records: warmMetrics.every((metrics) => metrics.inserted > 0),
      failure_injected_during_load: beforeFailure.publishedLoadEvents < loadEvents,
      positive_lag_observed_after_failure: lagAfterFailure.totalLag > 0,
      one_member_after_failure: finalGroup.memberCount === 1,
      survivor_owns_all_partitions: survivorMetrics.assignedPartitions === partitionCount,
      rebalance_recovered_under_30_seconds: recoveryMs < 30_000,
      final_lag_zero: finalLag.totalLag === 0,
      all_offsets_at_log_end: finalLag.partitions.every((item) => item.lag === 0),
      no_event_loss: warehouse.totalRows === expectedUniqueEvents,
      no_duplicate_rows: warehouse.totalRows === warehouse.uniqueEventIds,
      explicit_replays_suppressed: survivorMetrics.duplicates >= replayEvents,
      invalid_partition_key_not_inserted: invalidCount === 0,
      invalid_partition_key_dead_lettered:
        deadLetters.length === 1 && deadLetters[0].error?.kind === 'partition_key',
    };
    passed = Object.values(assertions).every(Boolean);
    const result = {
      evidenceType: 'local-multi-replica-rebalance-fault-test',
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      environment: {
        platform: `${os.platform()} ${os.release()}`,
        logicalCpu: os.cpus().length,
        memoryBytes: os.totalmem(),
        workerImage,
        workerImageId: imageId,
        kafka: 'Apache Kafka 3.9.1, single local KRaft broker',
        clickhouse: 'ClickHouse 24.8, single local node',
        schemaRegistry: 'Confluent Schema Registry 7.9.2, single local node',
      },
      topology: '12-partition Kafka topic -> two realtime-worker replicas -> ClickHouse; abrupt kill of one replica',
      workload: {
        partitionCount,
        warmupEvents,
        loadEvents,
        replayEvents,
        invalidPartitionKeyEvents: 1,
        killAfterEvents,
        expectedUniqueEvents,
        kafkaSessionTimeoutMs,
        kafkaHeartbeatIntervalMs,
      },
      identifiers: {
        sourceTopic,
        deadLetterTopic,
        groupId,
        tenantId,
        invalidEventId,
        eventIdSetSha256: createHash('sha256').update(eventIds.sort().join('\n')).digest('hex'),
      },
      schema: { subject: schema.subject, id: schema.id, version: schema.version },
      beforeFailure,
      lagAfterFailure,
      afterFailure,
      recoveryMs,
      finalLag,
      warehouse,
      survivorMetrics,
      deadLetter: {
        count: deadLetters.length,
        record: deadLetters[0] || null,
      },
      assertions,
      passed,
      evidenceBoundary:
        'Synthetic local correctness/fault evidence with one Kafka broker and one ClickHouse node; not broker HA, multi-AZ, throughput, or production-capacity proof.',
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await cleanup();
  }

  if (!passed) process.exitCode = 1;
}

function startWorker(name, index) {
  docker([
    'run',
    '--detach',
    '--rm',
    '--init',
    '--name', name,
    '--network', dockerNetwork,
    '--publish', '127.0.0.1::9103',
    '--stop-timeout', '45',
    '--env', `KAFKA_CLIENT_ID=rebalance-worker-${index}-${runId}`,
    '--env', `KAFKA_BROKERS=${workerBrokers}`,
    '--env', `KAFKA_TELEMETRY_TOPIC=${sourceTopic}`,
    '--env', `KAFKA_TELEMETRY_DLQ_TOPIC=${deadLetterTopic}`,
    '--env', `KAFKA_GROUP_ID=${groupId}`,
    '--env', `KAFKA_SESSION_TIMEOUT_MS=${kafkaSessionTimeoutMs}`,
    '--env', `KAFKA_HEARTBEAT_INTERVAL_MS=${kafkaHeartbeatIntervalMs}`,
    '--env', `SCHEMA_REGISTRY_URL=${workerSchemaRegistryUrl}`,
    '--env', `SCHEMA_REGISTRY_SUBJECT=${schemaSubject}`,
    '--env', 'SCHEMA_REGISTRY_CACHE_MAX_ENTRIES=100',
    '--env', 'SCHEMA_REGISTRY_TIMEOUT_MS=5000',
    '--env', `CLICKHOUSE_URL=${workerClickHouseUrl}`,
    '--env', `CLICKHOUSE_USER=${clickHouseUser}`,
    '--env', `CLICKHOUSE_PASSWORD=${clickHousePassword}`,
    '--env', `CLICKHOUSE_DB=${clickHouseDb}`,
    '--env', 'IDEMPOTENCY_CACHE_TTL_MS=900000',
    '--env', 'IDEMPOTENCY_CACHE_MAX_ENTRIES=100000',
    workerImage,
  ]);
  startedContainers.push(name);
  const binding = docker(['port', name, '9103/tcp']).trim();
  const port = binding.match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error(`Could not resolve metrics port for ${name}: ${binding}`);
  return `http://127.0.0.1:${port}`;
}

function buildEvents(count, startSequence, schema, eventIds) {
  const timestamp = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const sequence = startSequence + index;
    const partition = sequence % partitionCount;
    const eventId = randomUUID();
    eventIds.push(eventId);
    const deviceId = deviceIdFor(partition);
    return messageForEvent(
      telemetryEvent(eventId, deviceId, sequence, timestamp),
      schema,
      partition,
      deviceId,
    );
  });
}

function telemetryEvent(eventId, deviceId, sequence, timestamp) {
  return {
    eventType: 'device.telemetry.received',
    eventId,
    traceId: eventId,
    schemaVersion: 1,
    tenantId,
    deviceId,
    occurredAt: timestamp,
    receivedAt: timestamp,
    sequence,
    heartRate: 62,
    breathingRate: 14,
    bodyMovement: 0.2,
    sleepState: 'deep',
    confidence: 0.94,
  };
}

function messageForEvent(event, schema, partition, key) {
  return {
    partition,
    key,
    value: JSON.stringify(event),
    headers: {
      tenantId,
      traceId: event.eventId,
      contractVersion: '1',
      schemaId: String(schema.id),
      schemaSubject: schema.subject,
      schemaVersion: String(schema.version),
    },
  };
}

function deviceIdFor(partition) {
  return `device-${partition}-${runId}`.slice(0, 128);
}

async function publishBatches(messages, size) {
  for (let index = 0; index < messages.length; index += size) {
    await publish(messages.slice(index, index + size));
  }
}

async function publish(messages) {
  await producer.send({ topic: sourceTopic, acks: -1, messages });
}

async function latestSchema() {
  const response = await fetch(
    `${hostSchemaRegistryUrl.replace(/\/+$/, '')}/subjects/${encodeURIComponent(schemaSubject)}/versions/latest`,
    {
      headers: { accept: 'application/vnd.schemaregistry.v1+json' },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Schema Registry lookup failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function readWorkerMetrics(baseUrl) {
  const [readyResponse, metricsResponse] = await Promise.all([
    fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) }),
    fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(2_000) }),
  ]);
  if (!metricsResponse.ok) throw new Error(`Worker metrics failed: ${metricsResponse.status}`);
  const body = await metricsResponse.text();
  return {
    ready: readyResponse.ok,
    assignedPartitions: metric(body, 'sleep_realtime_consumer_assigned_partitions'),
    joins: metric(body, 'sleep_realtime_consumer_group_events_total', { event: 'join' }),
    inserted: metric(body, 'sleep_realtime_events_total', { outcome: 'inserted' }),
    duplicates: metric(body, 'sleep_realtime_events_total', { outcome: 'duplicate' }),
    invalidEvents: metric(body, 'sleep_realtime_events_total', { outcome: 'invalid_event' }),
    deadLettered: metric(body, 'sleep_realtime_events_total', { outcome: 'dead_lettered' }),
  };
}

function metric(body, name, labels = {}) {
  const labelText = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const prefix = labelText ? `${name}{${labelText}}` : name;
  const line = body.split('\n').find((candidate) => candidate.startsWith(`${prefix} `));
  return line ? Number(line.slice(prefix.length + 1)) : 0;
}

async function describeGroup() {
  const description = await admin.describeGroups([groupId]);
  const group = description.groups.find((item) => item.groupId === groupId);
  if (!group) return { state: 'Missing', memberCount: 0, protocol: null };
  return {
    state: group.state,
    memberCount: group.members.length,
    protocol: group.protocol,
    members: group.members.map((member) => ({
      clientId: member.clientId,
      clientHost: member.clientHost,
    })),
  };
}

async function groupLag() {
  const [endOffsets, committedTopics] = await Promise.all([
    admin.fetchTopicOffsets(sourceTopic),
    admin.fetchOffsets({ groupId, topics: [sourceTopic] }),
  ]);
  const committed = new Map(
    (committedTopics.find((item) => item.topic === sourceTopic)?.partitions || [])
      .map((item) => [item.partition, item.offset]),
  );
  const partitions = endOffsets
    .map((item) => {
      const current = committed.get(item.partition) || '-1';
      const effectiveCurrent = current === '-1' ? item.low : current;
      return {
        partition: item.partition,
        current: Number(effectiveCurrent),
        end: Number(item.high),
        lag: Number(BigInt(item.high) - BigInt(effectiveCurrent)),
      };
    })
    .sort((left, right) => left.partition - right.partition);
  return {
    totalLag: partitions.reduce((total, item) => total + item.lag, 0),
    partitions,
  };
}

async function queryTenantCounts() {
  const data = await clickHouseQuery(
    'SELECT count() AS total_rows, uniqExact(event_id) AS unique_event_ids FROM raw.device_telemetry WHERE tenant_id = {tenant:String} FORMAT JSON',
    { tenant: tenantId },
  );
  const row = data.data[0];
  return {
    totalRows: Number(row.total_rows),
    uniqueEventIds: Number(row.unique_event_ids),
  };
}

async function queryEventCount(eventId) {
  const data = await clickHouseQuery(
    'SELECT count() AS total_rows FROM raw.device_telemetry WHERE event_id = {eventId:UUID} FORMAT JSON',
    { eventId },
  );
  return Number(data.data[0].total_rows);
}

async function clickHouseQuery(query, params) {
  const url = new URL(hostClickHouseUrl);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(`param_${name}`, value);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clickHouseUser}:${clickHousePassword}`).toString('base64')}`,
      'content-type': 'text/plain',
    },
    body: query,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ClickHouse query failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function poll(probe, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function cleanup() {
  if (!passed) {
    for (const name of startedContainers) {
      try {
        const logs = docker(['logs', '--tail', '100', name]);
        if (logs.trim()) process.stderr.write(`\n--- ${name} ---\n${logs}\n`);
      } catch {}
    }
  }
  if (dlqConsumerConnected) await dlqConsumer.disconnect().catch(() => {});
  if (producerConnected) await producer.disconnect().catch(() => {});
  for (const name of startedContainers) {
    try {
      docker(['rm', '--force', name]);
    } catch {}
  }
  if (adminConnected && topicsCreated && process.env.KEEP_TEST_TOPICS !== 'true') {
    await admin.deleteTopics({ topics: [sourceTopic, deadLetterTopic] }).catch(() => {});
  }
  if (adminConnected) await admin.disconnect().catch(() => {});
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'UNCOMMITTED_WORKTREE';
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.log(JSON.stringify({
    evidenceType: 'local-multi-replica-rebalance-fault-test',
    runId,
    finishedAt: new Date().toISOString(),
    passed: false,
    error: error.message,
  }, null, 2));
  process.exitCode = 1;
});
