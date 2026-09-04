import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '../..');
const composeFile = resolve(workspace, 'platform/local/docker-compose.enterprise.yml');
const envFile = resolve(workspace, 'platform/local/.env.example');
const runId = (process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, '-')).slice(0, 80);
const outputPath = resolve(
  workspace,
  process.env.EVIDENCE_OUTPUT || `202607worklog/performance/raw/${runId}-flink-event-time.json`,
);
const clickHousePassword = required('CLICKHOUSE_PASSWORD');
const sourceTopic = `telemetry.flink.source.${runId}`.slice(0, 220);
const groupId = `flink-event-time-${runId}`.slice(0, 220);
const tenantId = `tenant-flink-${runId}`.slice(0, 120);
const outputTopics = {
  dwd: 'telemetry.flink.dwd.v1',
  late: 'telemetry.flink.late.v1',
  aggregate: 'telemetry.flink.aggregate.v1',
  invalid: 'telemetry.flink.invalid.v1',
  duplicate: 'telemetry.flink.duplicate.v1',
};

let jobId;
let result = {
  evidenceType: 'local-flink-event-time-and-exactly-once-smoke',
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  passed: false,
};

try {
  await waitFor(async () => {
    const overview = await jsonFetch('http://127.0.0.1:8082/overview');
    return overview.taskmanagers >= 1 && overview['slots-available'] >= 1 ? overview : null;
  }, 300_000, 'Flink JobManager and TaskManager readiness');

  kafka([
    'topics', '--create', '--if-not-exists', '--topic', sourceTopic,
    '--partitions', '1', '--replication-factor', '1',
  ]);

  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', 'sleep-flink-telemetry-job:local']).trim();
  const submitOutput = compose([
    'exec', '-T', 'flink-jobmanager',
    'flink', 'run', '-d', '/opt/flink/usrlib/flink-telemetry-job.jar',
    '--bootstrap-servers', 'kafka:9092',
    '--source-topic', sourceTopic,
    '--group-id', groupId,
    '--run-id', runId,
    '--checkpoint-uri', `file:///opt/flink/checkpoints/${runId}`,
    '--dwd-topic', outputTopics.dwd,
    '--late-topic', outputTopics.late,
    '--aggregate-topic', outputTopics.aggregate,
    '--invalid-topic', outputTopics.invalid,
    '--duplicate-topic', outputTopics.duplicate,
    '--watermark-seconds', '5',
    '--window-minutes', '1',
    '--checkpoint-interval-ms', '10000',
    '--parallelism', '1',
  ]);
  jobId = submitOutput.match(/JobID ([a-f0-9]{32})/i)?.[1];
  if (!jobId) throw new Error(`Unable to parse Flink JobID from: ${submitOutput}`);

  await waitFor(async () => {
    const job = await jsonFetch(`http://127.0.0.1:8082/jobs/${jobId}`);
    return job.state === 'RUNNING' ? job : null;
  }, 120_000, 'Flink job RUNNING state');

  const ids = {
    first: randomUUID(),
    second: randomUUID(),
    inBoundOutOfOrder: randomUUID(),
    watermarkAdvance: randomUUID(),
    deliberatelyLate: randomUUID(),
    invalid: randomUUID(),
    secondWatermarkAdvance: randomUUID(),
  };
  const firstBatch = [
    telemetry(ids.first, 'device-a', '2026-07-30T00:00:10.000Z', 1, 60, 12),
    telemetry(ids.second, 'device-b', '2026-07-30T00:00:20.000Z', 2, 70, 14),
    telemetry(ids.first, 'device-a', '2026-07-30T00:00:10.000Z', 1, 60, 12),
    telemetry(ids.inBoundOutOfOrder, 'device-a', '2026-07-30T00:00:18.000Z', 3, 80, 16),
    telemetry(ids.watermarkAdvance, 'device-b', '2026-07-30T00:01:10.000Z', 4, 90, 18),
  ];
  publish(firstBatch);
  await delay(1_500);
  const invalid = telemetry(ids.invalid, 'device-invalid', '2026-07-30T00:01:20.000Z', 6, 999, 14);
  publish([
    telemetry(ids.deliberatelyLate, 'device-late', '2026-07-30T00:00:30.000Z', 5, 100, 20),
    invalid,
    telemetry(ids.secondWatermarkAdvance, 'device-a', '2026-07-30T00:02:10.000Z', 7, 50, 10),
  ]);

  const kafkaOutputs = await waitFor(async () => {
    const values = Object.fromEntries(
      Object.entries(outputTopics).map(([name, topic]) => [name, consume(topic).filter(item => item.run_id === runId)]),
    );
    return values.dwd.length === 5 &&
      values.late.length === 1 &&
      values.aggregate.length >= 2 &&
      values.invalid.length === 1 &&
      values.duplicate.length === 1 ? values : null;
  }, 240_000, 'all committed Flink Kafka outputs');

  const checkpoints = await waitFor(async () => {
    const value = await jsonFetch(`http://127.0.0.1:8082/jobs/${jobId}/checkpoints`);
    return value.counts?.completed >= 1 ? value : null;
  }, 120_000, 'at least one completed Flink checkpoint');

  const warehouse = await waitFor(async () => {
    const value = await warehouseSnapshot();
    return value.dwd_rows === 5 && value.late_rows === 1 && value.aggregate_rows >= 2 &&
      value.invalid_rows === 1 && value.duplicate_rows === 1 ? value : null;
  }, 240_000, 'ClickHouse DWD, DWS, late, invalid, and duplicate materialization');

  const windowRows = kafkaOutputs.aggregate
    .sort((left, right) => left.window_start_ms - right.window_start_ms)
    .slice(0, 2);
  const dwdIds = new Set(kafkaOutputs.dwd.map(item => item.event_id));
  const assertions = {
    flink_job_running: true,
    checkpoint_completed: checkpoints.counts.completed >= 1,
    checkpoint_failures_zero: checkpoints.counts.failed === 0,
    committed_dwd_count_exact: kafkaOutputs.dwd.length === 5,
    duplicate_count_exact: kafkaOutputs.duplicate.length === 1,
    duplicate_event_identified: kafkaOutputs.duplicate[0]?.event_id === ids.first,
    in_bound_out_of_order_accepted: dwdIds.has(ids.inBoundOutOfOrder),
    late_count_exact: kafkaOutputs.late.length === 1,
    deliberately_late_identified: kafkaOutputs.late[0]?.event_id === ids.deliberatelyLate,
    late_excluded_from_dwd: !dwdIds.has(ids.deliberatelyLate),
    invalid_count_exact: kafkaOutputs.invalid.length === 1,
    invalid_excluded_from_dwd: !dwdIds.has(ids.invalid),
    first_window_count_exact: windowRows[0]?.telemetry_events === 3,
    first_window_average_exact: windowRows[0]?.avg_heart_rate === 70,
    second_window_count_exact: windowRows[1]?.telemetry_events === 1,
    second_window_average_exact: windowRows[1]?.avg_heart_rate === 90,
    clickhouse_dwd_count_exact: warehouse.dwd_rows === 5 && warehouse.dwd_unique_events === 5,
    clickhouse_governance_counts_exact:
      warehouse.late_rows === 1 && warehouse.invalid_rows === 1 && warehouse.duplicate_rows === 1,
    clickhouse_window_count_exact: warehouse.aggregate_rows === 2,
  };
  const passed = Object.values(assertions).every(Boolean);
  result = {
    ...result,
    status: passed ? 'passed' : 'failed',
    passed,
    finishedAt: new Date().toISOString(),
    environment: {
      flinkVersion: '1.20.1',
      kafkaVersion: '3.9.1',
      clickHouseVersion: '24.8.14.39',
      flinkImageId: imageId,
      parallelism: 1,
      sourcePartitions: 1,
      watermarkSeconds: 5,
      windowMinutes: 1,
      checkpointIntervalMs: 10_000,
      kafkaConsumerIsolation: 'read_committed',
    },
    topology: { sourceTopic, groupId, outputTopics, jobId },
    workload: {
      inputRecords: 8,
      expectedDwdRecords: 5,
      expectedLateRecords: 1,
      expectedInvalidRecords: 1,
      expectedDuplicateRecords: 1,
      eventIds: ids,
    },
    checkpoints: {
      completed: checkpoints.counts.completed,
      failed: checkpoints.counts.failed,
      latestCompleted: checkpoints.latest?.completed ?? null,
    },
    kafkaOutputs,
    warehouse,
    assertions,
  };
  if (!passed) throw new Error('One or more event-time assertions failed');
} catch (error) {
  result = {
    ...result,
    status: 'failed',
    passed: false,
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
  };
  process.exitCode = 1;
} finally {
  if (jobId) {
    await fetch(`http://127.0.0.1:8082/jobs/${jobId}?mode=cancel`, { method: 'PATCH' }).catch(() => null);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (result.status === 'failed' && result.assertions) {
    const failedAssertions = Object.entries(result.assertions)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    console.log(JSON.stringify({
      outputPath,
      runId,
      status: result.status,
      passed: result.passed,
      failedAssertions,
      observed: {
        dwd: result.kafkaOutputs?.dwd?.length,
        late: result.kafkaOutputs?.late?.length,
        aggregate: result.kafkaOutputs?.aggregate?.length,
        invalid: result.kafkaOutputs?.invalid?.length,
        duplicate: result.kafkaOutputs?.duplicate?.length,
        warehouse: result.warehouse,
      },
      error: result.error ?? null,
    }, null, 2));
  } else {
    console.log(JSON.stringify({ outputPath, runId, status: result.status, passed: result.passed }, null, 2));
  }
}

function telemetry(eventId, deviceId, occurredAt, sequence, heartRate, breathingRate) {
  return JSON.stringify({
    eventType: 'device.telemetry.received',
    eventId,
    traceId: eventId,
    schemaVersion: 1,
    tenantId,
    deviceId,
    occurredAt,
    receivedAt: new Date(Date.parse(occurredAt) + 250).toISOString(),
    sequence,
    heartRate,
    breathingRate,
    bodyMovement: 0.2,
    sleepState: 'deep',
    confidence: 0.95,
  });
}

function publish(records) {
  kafka(['console-producer', '--topic', sourceTopic, '--producer-property', 'acks=all'], `${records.join('\n')}\n`);
}

function consume(topic) {
  const output = kafka([
    'console-consumer', '--topic', topic, '--from-beginning', '--timeout-ms', '3000',
    '--consumer-property', 'isolation.level=read_committed',
  ], undefined, true);
  return output.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function kafka(args, input, allowFailure = false) {
  return compose(['exec', '-T', 'kafka', `/opt/kafka/bin/kafka-${args[0]}.sh`, '--bootstrap-server', 'kafka:9092', ...args.slice(1)], input, allowFailure);
}

function compose(args, input, allowFailure = false) {
  return docker(['compose', '--env-file', envFile, '-f', composeFile, ...args], input, allowFailure);
}

function docker(args, input, allowFailure = false) {
  const run = spawnSync('docker', args, { cwd: workspace, encoding: 'utf8', input, maxBuffer: 20 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed (${run.status}): ${run.stderr || run.stdout}`);
  }
  return run.stdout || '';
}

async function warehouseSnapshot() {
  const query = `
    SELECT toJSONString(map(
      'dwd_rows', toString((SELECT count() FROM dwd.device_telemetry WHERE run_id = '${sql(runId)}')),
      'dwd_unique_events', toString((SELECT uniqExact(event_id) FROM dwd.device_telemetry WHERE run_id = '${sql(runId)}')),
      'late_rows', toString((SELECT count() FROM raw.device_telemetry_late WHERE run_id = '${sql(runId)}')),
      'aggregate_rows', toString((SELECT count() FROM dws.tenant_telemetry_minute FINAL WHERE run_id = '${sql(runId)}')),
      'invalid_rows', toString((SELECT count() FROM raw.flink_invalid_telemetry WHERE run_id = '${sql(runId)}')),
      'duplicate_rows', toString((SELECT count() FROM raw.flink_duplicate_telemetry WHERE run_id = '${sql(runId)}'))
    )) FORMAT TSVRaw`;
  const response = await fetch(`http://127.0.0.1:8123/?query=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`sleep:${clickHousePassword}`).toString('base64')}` },
  });
  if (!response.ok) throw new Error(`ClickHouse query failed: ${response.status} ${await response.text()}`);
  const raw = JSON.parse((await response.text()).trim());
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value)]));
}

async function jsonFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sql(value) {
  return value.replaceAll("'", "''");
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
