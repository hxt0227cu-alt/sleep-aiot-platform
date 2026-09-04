import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { compileTelemetrySchema } from './telemetry-schema';

const validate = compileTelemetrySchema(
  resolve(process.cwd(), '../../platform/data-contracts/device-telemetry.v1.schema.json'),
);

const validEvent = {
  eventId: '019c0000-0000-7000-8000-000000000001',
  schemaVersion: 1,
  tenantId: 'tenant-schema-test',
  deviceId: 'device-schema-test',
  occurredAt: '2026-07-24T10:00:00.000Z',
  sequence: 1,
  heartRate: 62,
  breathingRate: 14,
  bodyMovement: 0.2,
  sleepState: 'deep',
  confidence: 0.94,
};

test('accepts a valid Draft 2020-12 telemetry event', () => {
  assert.equal(validate(validEvent), true, JSON.stringify(validate.errors));
});

test('rejects an invalid UUID', () => {
  assert.equal(validate({ ...validEvent, eventId: 'not-a-uuid' }), false);
});

test('rejects out-of-range measurements', () => {
  assert.equal(validate({ ...validEvent, heartRate: 241 }), false);
});

test('rejects undeclared fields', () => {
  assert.equal(validate({ ...validEvent, privateNote: 'must not enter the event bus' }), false);
});
