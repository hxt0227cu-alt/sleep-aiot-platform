import assert from 'assert';
import { createTelemetry, commandResponse } from './device-simulator.js';

const input = { tenantId: 'tenant-a', deviceId: 'sim-000001', sequence: 42, seed: 20260724, occurredAt: '2026-07-24T00:00:00.000Z' };
assert.deepStrictEqual(createTelemetry(input), createTelemetry(input));
assert.strictEqual(createTelemetry(input).evidence, 'simulated');
assert.strictEqual(commandResponse('sim-1', { commandId: 'cmd-1' }, 7, { timeoutEvery: 7 }), null);
assert.strictEqual(commandResponse('sim-1', { commandId: 'cmd-1' }, 1, { timeoutEvery: 0 }).status, 'acknowledged');
console.log('device simulator tests passed');
