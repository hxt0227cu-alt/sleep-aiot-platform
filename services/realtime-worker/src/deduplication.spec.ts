import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionNewEvents } from './deduplication';

test('rejects event IDs already persisted in ClickHouse', () => {
  const result = partitionNewEvents(
    [{ eventId: 'existing' }, { eventId: 'new' }],
    new Set(['existing']),
  );
  assert.deepEqual(result.accepted, [{ eventId: 'new' }]);
  assert.deepEqual(result.duplicates, [{ eventId: 'existing' }]);
});

test('keeps only the first occurrence inside one Kafka batch', () => {
  const result = partitionNewEvents(
    [{ eventId: 'same', offset: '10' }, { eventId: 'same', offset: '11' }],
    new Set(),
  );
  assert.deepEqual(result.accepted, [{ eventId: 'same', offset: '10' }]);
  assert.deepEqual(result.duplicates, [{ eventId: 'same', offset: '11' }]);
});
