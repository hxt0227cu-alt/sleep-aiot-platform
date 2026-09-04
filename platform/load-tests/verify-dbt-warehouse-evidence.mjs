import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const evidenceDirectory = resolve(workspace, '202607worklog/performance/raw');
const fullRefreshName = '20260731-dbt-feature-full-refresh.json';
const incrementalNames = [
  '20260731-dbt-feature-incremental-01.json',
  '20260731-dbt-feature-incremental-02.json',
  '20260731-dbt-feature-incremental-03.json',
];
const summaryName = '20260731-dbt-feature-warehouse-summary.json';
const fullRefresh = await readJson(resolve(evidenceDirectory, fullRefreshName));
const runs = await Promise.all(incrementalNames.map(name => readJson(resolve(evidenceDirectory, name))));

assertRun(fullRefresh, 'full-refresh');
runs.forEach(run => assertRun(run, 'incremental'));
const allRuns = [fullRefresh, ...runs];
assert.equal(new Set(allRuns.map(run => run.environment.dbtImageId)).size, 1, 'dbt image changed between formal runs');
assert.equal(new Set(allRuns.map(run => run.artifacts.graphFingerprintSha256)).size, 1, 'dbt graph changed between formal runs');
assert.equal(new Set(runs.map(run => JSON.stringify(run.warehouse))).size, 1, 'warehouse counts changed between incremental reruns');

const wallClock = runs.map(run => run.invocation.wallClockMs).sort(numeric);
const nodeExecution = runs.map(run => run.invocation.summedNodeExecutionMs).sort(numeric);
const warehouse = runs[0].warehouse;
const expectedSummary = {
  schemaVersion: 1,
  sourceRuns: incrementalNames,
  fullRefreshRun: fullRefreshName,
  dbtImageId: runs[0].environment.dbtImageId,
  aggregate: {
    incrementalWallClockMedianMs: wallClock[1],
    incrementalWallClockMinMs: wallClock[0],
    incrementalWallClockMaxMs: wallClock[2],
    incrementalNodeExecutionMedianMs: nodeExecution[1],
    incrementalNodeExecutionMinMs: nodeExecution[0],
    incrementalNodeExecutionMaxMs: nodeExecution[2],
    modelsPerRun: 5,
    testsPerRun: 24,
    totalSuccessfulNodes: runs.reduce((sum, run) => sum + run.invocation.modelCount + run.invocation.testCount, 0),
    rawRows: warehouse.raw_rows,
    rawUniqueEvents: warehouse.raw_unique_events,
    rawDuplicateRows: warehouse.raw_rows - warehouse.raw_unique_events,
    dwdRows: warehouse.dwd_rows,
    dwsRows: warehouse.dws_rows,
    adsRows: warehouse.ads_rows,
    deviceAdsRows: warehouse.device_ads_rows,
    allRunsPassed: true,
  },
  boundary: 'Local single-node ClickHouse correctness/repeatability evidence; not throughput, HA, or cloud capacity evidence.',
};

const summaryPath = resolve(evidenceDirectory, summaryName);
if (process.argv.includes('--write-summary')) {
  await writeFile(summaryPath, `${JSON.stringify(expectedSummary, null, 2)}\n`, 'utf8');
}
const summary = await readJson(summaryPath);
assert.deepEqual(summary, expectedSummary, 'dbt evidence summary differs from raw artifacts');
console.log(JSON.stringify({ verifiedRuns: [fullRefreshName, ...incrementalNames], ...expectedSummary, passed: true }, null, 2));

function assertRun(run, mode) {
  assert.equal(run.passed, true, `${run.runId} did not pass`);
  assert.equal(run.invocation.mode, mode, `${run.runId} mode changed`);
  assert.equal(Object.values(run.assertions).every(Boolean), true, `${run.runId} has a failed assertion`);
  assert.equal(run.invocation.modelCount, 5);
  assert.equal(run.invocation.testCount, 24);
  assert.deepEqual(run.invocation.statuses, { pass: 24, success: 5 });
  assert.equal(run.warehouse.dwd_rows, run.warehouse.raw_unique_events);
  assert.equal(run.warehouse.dwd_rows, run.warehouse.dwd_unique_events);
  assert.equal(run.warehouse.dws_rows, run.warehouse.dws_unique_keys);
  assert.equal(run.warehouse.ads_rows > 0, true);
  assert.equal(run.warehouse.device_ads_rows, run.warehouse.device_ads_unique_keys);
  assert.equal(run.warehouse.device_ads_rows > 0, true);
}

function numeric(left, right) {
  return left - right;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
