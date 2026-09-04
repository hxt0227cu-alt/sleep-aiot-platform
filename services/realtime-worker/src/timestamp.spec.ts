import assert from 'node:assert/strict';
import test from 'node:test';
import { toClickHouseDateTime64 } from './timestamp';

test('converts ISO 8601 timestamps to UTC DateTime64(3)', () => {
  assert.equal(
    toClickHouseDateTime64('2026-07-24T12:02:12.050Z'),
    '2026-07-24 12:02:12.050',
  );
});

test('normalizes timezone offsets to UTC', () => {
  assert.equal(
    toClickHouseDateTime64('2026-07-24T20:02:12.050+08:00'),
    '2026-07-24 12:02:12.050',
  );
});

test('rejects invalid timestamps', () => {
  assert.throws(() => toClickHouseDateTime64('not-a-timestamp'));
});
