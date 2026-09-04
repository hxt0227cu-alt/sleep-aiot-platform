import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const options = parseArgs(process.argv.slice(2));
const runId = required(options, 'run-id');
const artifactDirectory = resolve(workspace, required(options, 'artifact-dir'));
const expectedMode = required(options, 'expected-mode');
const imageId = required(options, 'image-id');
const adapterVersion = required(options, 'adapter-version');
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD;
assert(clickhousePassword, 'CLICKHOUSE_PASSWORD is required but is never written to evidence');
assert(['full-refresh', 'incremental'].includes(expectedMode), 'expected-mode must be full-refresh or incremental');

const targetDirectory = resolve(artifactDirectory, 'target');
const logPath = resolve(artifactDirectory, 'logs/dbt.log');
const manifestPath = resolve(targetDirectory, 'manifest.json');
const runResultsPath = resolve(targetDirectory, 'run_results.json');
const [manifestBuffer, runResultsBuffer, logMetadata] = await Promise.all([
  readFile(manifestPath),
  readFile(runResultsPath),
  stat(logPath),
]);
const manifest = JSON.parse(manifestBuffer);
const runResults = JSON.parse(runResultsBuffer);
const warehouse = await queryWarehouse(clickhousePassword);

const resources = Object.values(manifest.nodes);
const modelCount = resources.filter(node => node.resource_type === 'model').length;
const testCount = resources.filter(node => node.resource_type === 'test').length;
const statuses = runResults.results.reduce((counts, result) => {
  counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}, {});
const invocationCommand = runResults.args.invocation_command;
const fullRefresh = invocationCommand.includes('--full-refresh');
const startedAt = runResults.metadata.invocation_started_at;
const finishedAt = runResults.metadata.generated_at;
const assertions = {
  expectedMode: expectedMode === 'full-refresh' ? fullRefresh : !fullRefresh,
  invocationSucceeded: runResults.results.length === modelCount + testCount
    && runResults.results.every(result => ['pass', 'success'].includes(result.status)),
  expectedGraphSize: modelCount === 5 && testCount === 24,
  rawDuplicatesRetained: warehouse.raw_rows > warehouse.raw_unique_events,
  dwdMatchesUniqueSource: warehouse.dwd_rows === warehouse.raw_unique_events,
  dwdUnique: warehouse.dwd_rows === warehouse.dwd_unique_events,
  dwsUnique: warehouse.dws_rows === warehouse.dws_unique_keys,
  adsMaterialized: warehouse.ads_rows > 0,
  deviceAdsMaterialized: warehouse.device_ads_rows > 0,
  deviceAdsUnique: warehouse.device_ads_rows === warehouse.device_ads_unique_keys,
};
const evidence = {
  schemaVersion: 1,
  runId,
  classification: 'local synthetic warehouse correctness and repeatability evidence',
  passed: Object.values(assertions).every(Boolean),
  assertions,
  environment: {
    dbtImageId: imageId,
    dbtCoreVersion: runResults.metadata.dbt_version,
    dbtClickHouseVersion: adapterVersion,
    clickHouseVersion: warehouse.clickhouse_version,
    target: runResults.args.target,
    threads: 2,
  },
  invocation: {
    mode: expectedMode,
    command: invocationCommand,
    invocationId: runResults.metadata.invocation_id,
    startedAt,
    finishedAt,
    wallClockMs: Date.parse(finishedAt) - Date.parse(startedAt),
    summedNodeExecutionMs: Math.round(runResults.results.reduce((sum, result) => sum + result.execution_time, 0) * 1000),
    modelCount,
    testCount,
    statuses,
  },
  warehouse,
  artifacts: {
    directory: normalize(relative(workspace, artifactDirectory)),
    manifestSha256: sha256(manifestBuffer),
    runResultsSha256: sha256(runResultsBuffer),
    graphFingerprintSha256: graphFingerprint(resources),
    structuredLogBytes: logMetadata.size,
  },
  limitations: [
    'Single-node local ClickHouse correctness evidence; not a throughput, HA, cloud, or production-capacity result.',
    'Source data is synthetic and accumulated from prior local telemetry/Flink experiments.',
  ],
};

const outputDirectory = resolve(workspace, '202607worklog/performance/raw');
const outputPath = resolve(outputDirectory, `${runId}.json`);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: normalize(relative(workspace, outputPath)), ...evidence }, null, 2));
if (!evidence.passed) process.exitCode = 1;

async function queryWarehouse(password) {
  const query = `
    SELECT
      version() AS clickhouse_version,
      (SELECT count() FROM raw.device_telemetry) AS raw_rows,
      (SELECT uniqExact(event_id) FROM raw.device_telemetry) AS raw_unique_events,
      (SELECT count() FROM dwd.dwd_device_telemetry FINAL) AS dwd_rows,
      (SELECT uniqExact(event_id) FROM dwd.dwd_device_telemetry FINAL) AS dwd_unique_events,
      (SELECT count() FROM dws.dws_tenant_sleep_hourly FINAL) AS dws_rows,
      (SELECT uniqExact(tuple(tenant_id, hour)) FROM dws.dws_tenant_sleep_hourly FINAL) AS dws_unique_keys,
      (SELECT count() FROM ads.ads_agent_sleep_features) AS ads_rows,
      (SELECT count() FROM ads.ads_agent_device_sleep_features) AS device_ads_rows,
      (SELECT uniqExact(tuple(tenant_id, device_id)) FROM ads.ads_agent_device_sleep_features) AS device_ads_unique_keys
    FORMAT JSON
  `;
  const response = await fetch(process.env.CLICKHOUSE_HTTP_URL ?? 'http://127.0.0.1:8123/', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER ?? 'sleep'}:${password}`).toString('base64')}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`ClickHouse query failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  assert.equal(payload.rows, 1, 'ClickHouse reconciliation must return exactly one row');
  const row = payload.data[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, /^\d+$/.test(String(value)) ? Number(value) : value]));
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index]?.startsWith('--'), `invalid argument ${args[index] ?? ''}`);
    parsed[args[index].slice(2)] = args[index + 1];
  }
  return parsed;
}

function required(values, key) {
  assert(values[key], `--${key} is required`);
  return values[key];
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function graphFingerprint(nodes) {
  const graph = nodes
    .filter(node => ['model', 'test'].includes(node.resource_type))
    .map(node => ({
      uniqueId: node.unique_id,
      resourceType: node.resource_type,
      checksum: node.checksum?.checksum ?? null,
      schema: node.schema,
      materialized: node.config?.materialized ?? null,
      dependencies: [...(node.depends_on?.nodes ?? [])].sort(),
    }))
    .sort((left, right) => left.uniqueId.localeCompare(right.uniqueId));
  return sha256(JSON.stringify(graph));
}

function normalize(path) {
  return path.replaceAll('\\', '/');
}
