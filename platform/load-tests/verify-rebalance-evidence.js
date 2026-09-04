import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceDirectory = resolve(workspace, '202607worklog/performance/raw');
const runNames = [
  '20260730-rebalance-fault-04.json',
  '20260730-rebalance-fault-05.json',
  '20260730-rebalance-fault-06.json',
];
const summaryName = '20260730-rebalance-fault-summary.json';

const runs = await Promise.all(runNames.map((name) => readJson(resolve(evidenceDirectory, name))));
const summary = await readJson(resolve(evidenceDirectory, summaryName));

const imageIds = new Set(runs.map((run) => run.environment.workerImageId));
assert.equal(imageIds.size, 1, 'all formal runs must use one Worker image');
assert.equal([...imageIds][0], summary.workerImageId, 'summary image must match raw runs');

for (const run of runs) {
  assert.equal(run.passed, true, `${run.runId} did not pass`);
  assert.equal(
    Object.values(run.assertions).every(Boolean),
    true,
    `${run.runId} contains a failed assertion`,
  );
  assert.equal(run.workload.partitionCount, summary.workloadPerRun.partitions);
  assert.equal(run.workload.warmupEvents, summary.workloadPerRun.warmupEvents);
  assert.equal(run.workload.loadEvents, summary.workloadPerRun.loadEvents);
  assert.equal(run.workload.replayEvents, summary.workloadPerRun.explicitReplays);
  assert.equal(run.finalLag.totalLag, 0, `${run.runId} retained Kafka lag`);
  assert.equal(
    run.finalLag.partitions.every((partition) => partition.current === partition.end && partition.lag === 0),
    true,
    `${run.runId} contains a partition offset below log end`,
  );
  assert.equal(run.warehouse.totalRows, run.workload.expectedUniqueEvents);
  assert.equal(run.warehouse.uniqueEventIds, run.workload.expectedUniqueEvents);
  assert.ok(run.survivorMetrics.duplicates >= run.workload.replayEvents);
  assert.equal(run.deadLetter.count, 1);
  assert.equal(run.deadLetter.record.error.kind, 'partition_key');
}

const recovery = runs.map((run) => run.recoveryMs).sort((left, right) => left - right);
const peakLag = runs.map((run) => run.lagAfterFailure.totalLag).sort((left, right) => left - right);
const expectedAggregate = {
  recoveryMedianMs: recovery[1],
  recoveryMinMs: recovery[0],
  recoveryMaxMs: recovery[2],
  recoveryRangeMs: recovery[2] - recovery[0],
  peakObservedLagMedian: peakLag[1],
  peakObservedLagMin: peakLag[0],
  peakObservedLagMax: peakLag[2],
  acceptedUniqueEventsAcrossRuns: runs.reduce(
    (total, run) => total + run.workload.expectedUniqueEvents,
    0,
  ),
  missingEvents: 0,
  duplicateRows: 0,
  explicitReplaysSuppressed: runs.reduce(
    (total, run) => total + run.workload.replayEvents,
    0,
  ),
  partitionKeyDeadLetters: runs.length,
  allRunsPassed: true,
};
assert.deepEqual(summary.aggregate, expectedAggregate, 'summary aggregate does not match raw evidence');
assert.deepEqual(summary.sourceRuns, runNames, 'summary source file list changed');

console.log(JSON.stringify({
  verifiedRuns: runNames,
  workerImageId: summary.workerImageId,
  aggregate: expectedAggregate,
  passed: true,
}, null, 2));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
