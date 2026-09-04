import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  decodeTelemetryEvent,
  validateDevicePartitionKey,
} from "./telemetry-event";
import { compileTelemetrySchema } from "./telemetry-schema";

const validate = compileTelemetrySchema(
  resolve(
    process.cwd(),
    "../../platform/data-contracts/device-telemetry-received.v1.schema.json",
  ),
);

const validEvent = {
  eventType: "device.telemetry.received",
  eventId: "019c0000-0000-7000-8000-000000000001",
  traceId: "019c0000-0000-7000-8000-000000000001",
  schemaVersion: 1,
  tenantId: "tenant-schema-test",
  deviceId: "device-schema-test",
  occurredAt: "2026-07-24T10:00:00.000Z",
  receivedAt: "2026-07-24T10:00:01.000Z",
  sequence: 1,
  heartRate: 62,
};

test("decodes a valid event-bus telemetry envelope", () => {
  const result = decodeTelemetryEvent(
    Buffer.from(JSON.stringify(validEvent)),
    validate,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event.eventId, validEvent.eventId);
});

test("classifies a null Kafka value", () => {
  const result = decodeTelemetryEvent(null, validate);
  assert.deepEqual(result, {
    ok: false,
    kind: "null_value",
    message: "Kafka message value is null",
  });
});

test("classifies invalid JSON", () => {
  const result = decodeTelemetryEvent(Buffer.from("{broken"), validate);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "invalid_json");
});

test("rejects a structurally invalid event-bus envelope", () => {
  const result = decodeTelemetryEvent(
    Buffer.from(
      JSON.stringify({ ...validEvent, tenantId: "", heartRate: 999 }),
    ),
    validate,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "schema_validation");
    assert.ok((result.validationErrors?.length || 0) >= 2);
  }
});

test("accepts only a Kafka key equal to the payload device ID", () => {
  assert.deepEqual(
    validateDevicePartitionKey(
      Buffer.from(validEvent.deviceId),
      validEvent.deviceId,
    ),
    { ok: true },
  );
  assert.deepEqual(validateDevicePartitionKey(null, validEvent.deviceId), {
    ok: false,
    kind: "partition_key",
    message: "Kafka message key is required and must equal payload deviceId",
  });
  assert.deepEqual(
    validateDevicePartitionKey(Buffer.from("wrong-device"), validEvent.deviceId),
    {
      ok: false,
      kind: "partition_key",
      message: "Kafka message key does not equal payload deviceId",
    },
  );
});
