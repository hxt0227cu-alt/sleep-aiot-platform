import assert from 'node:assert/strict';
import test from 'node:test';
import { RecentEventIdCache } from './recent-event-cache';

test('retains IDs only inside the configured TTL', () => {
  let now = 1_000;
  const cache = new RecentEventIdCache(100, 10, () => now);
  cache.add('event-1');
  assert.equal(cache.has('event-1'), true);
  now = 1_100;
  assert.equal(cache.has('event-1'), false);
});

test('evicts the oldest ID when capacity is reached', () => {
  const cache = new RecentEventIdCache(1_000, 2, () => 1_000);
  cache.add('event-1');
  cache.add('event-2');
  cache.add('event-3');
  assert.equal(cache.has('event-1'), false);
  assert.equal(cache.has('event-2'), true);
  assert.equal(cache.has('event-3'), true);
});
