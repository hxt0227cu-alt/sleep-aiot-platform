import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const evidenceDirectory = resolve(workspace, '202607worklog/performance/raw');
const runNames = [
  '20260730-flink-event-time-01.json',
  '20260730-flink-event-time-02.json',
  '20260730-flink-event-time-03.json',
];
const summaryName = '20260730-flink-event-time-summary.json';
const runs = await Promise.all(runNames.map(name => readJson(resolve(evidenceDirectory, name))));
const summary = await readJson(resolve(evidenceDirectory, summaryName));

assert.deepEqual(summary.sourceRuns, runNames, 'summary source run list changed');
assert.equal(new Set(runs.map(run => run.environment.flinkImageId)).size, 1, 'formal runs used different images');
assert.equal(runs[0].environment.flinkImageId, summary.flinkImageId, 'summary image does not match raw runs');

for (const run of runs) {
  assert.equal(run.passed, true, `${run.runId} did not pass`);
  assert.equal(Object.values(run.assertions).every(Boolean), true, `${run.runId} has a failed assertion`);
  assert.equal(run.checkpoints.completed >= 1, true, `${run.runId} has no completed checkpoint`);
  assert.equal(run.checkpoints.failed, 0, `${run.runId} has failed checkpoints`);
  assert.equal(run.environment.kafkaConsumerIsolation, 'read_committed');
  assert.equal(run.kafkaOutputs.dwd.length, 5);
  assert.equal(new Set(run.kafkaOutputs.dwd.map(item => item.event_id)).size, 5);
  assert.equal(run.kafkaOutputs.late.length, 1);
  assert.equal(run.kafkaOutputs.invalid.length, 1);
  assert.equal(run.kafkaOutputs.duplicate.length, 1);
  assert.equal(run.kafkaOutputs.duplicate[0].event_id, run.workload.eventIds.first);
  assert.equal(run.kafkaOutputs.late[0].event_id, run.workload.eventIds.deliberatelyLate);
  const dwdIds = new Set(run.kafkaOutputs.dwd.map(item => item.event_id));
  assert.equal(dwdIds.has(run.workload.eventIds.inBoundOutOfOrder), true);
  assert.equal(dwdIds.has(run.workload.eventIds.deliberatelyLate), false);
  assert.equal(dwdIds.has(run.workload.eventIds.invalid), false);
  const windows = run.kafkaOutputs.aggregate.sort((left, right) => left.window_start_ms - right.window_start_ms);
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map(item => ({ events: item.telemetry_events, heartRate: item.avg_heart_rate })),
    [{ events: 3, heartRate: 70 }, { events: 1, heartRate: 90 }],
  );
  assert.deepEqual(run.warehouse, {
    dwd_rows: 5,
    dwd_unique_events: 5,
    late_rows: 1,
    aggregate_rows: 2,
    invalid_rows: 1,
    duplicate_rows: 1,
  });
}

const runtimes = runs.map(run => Date.parse(run.finishedAt) - Date.parse(run.startedAt)).sort(numeric);
const checkpointDurations = runs.map(run => run.checkpoints.latestCompleted.end_to_end_duration).sort(numeric);
const checkpointSizes = new Set(runs.map(run => run.checkpoints.latestCompleted.checkpointed_size));
assert.equal(checkpointSizes.size, 1, 'latest checkpoint state size differs between formal runs');

const expectedAggregate = {
  observationRuntimeMedianMs: runtimes[1],
  observationRuntimeMinMs: runtimes[0],
  observationRuntimeMaxMs: runtimes[2],
  observationRuntimeRangeMs: runtimes[2] - runtimes[0],
  latestCheckpointDurationMedianMs: checkpointDurations[1],
  latestCheckpointDurationMinMs: checkpointDurations[0],
  latestCheckpointDurationMaxMs: checkpointDurations[2],
  latestCheckpointStateBytes: [...checkpointSizes][0],
  completedCheckpoints: runs.reduce((sum, run) => sum + run.checkpoints.completed, 0),
  failedCheckpoints: runs.reduce((sum, run) => sum + run.checkpoints.failed, 0),
  inputRecords: runs.reduce((sum, run) => sum + run.workload.inputRecords, 0),
  dwdRecords: runs.reduce((sum, run) => sum + run.warehouse.dwd_rows, 0),
  dwdUniqueEvents: runs.reduce((sum, run) => sum + run.warehouse.dwd_unique_events, 0),
  lateRecords: runs.reduce((sum, run) => sum + run.warehouse.late_rows, 0),
  invalidRecords: runs.reduce((sum, run) => sum + run.warehouse.invalid_rows, 0),
  duplicateRecords: runs.reduce((sum, run) => sum + run.warehouse.duplicate_rows, 0),
  aggregateWindows: runs.reduce((sum, run) => sum + run.warehouse.aggregate_rows, 0),
  allRunsPassed: true,
};
assert.deepEqual(summary.aggregate, expectedAggregate, 'summary aggregate differs from raw evidence');

console.log(JSON.stringify({ verifiedRuns: runNames, flinkImageId: summary.flinkImageId, aggregate: expectedAggregate, passed: true }, null, 2));

function numeric(left, right) {
  return left - right;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
