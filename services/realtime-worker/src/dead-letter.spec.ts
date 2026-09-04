import assert from "node:assert/strict";
import test from "node:test";
import { buildDeadLetterRecord } from "./dead-letter";

const baseInput = {
  topic: "telemetry.device.v1",
  partition: 3,
  offset: "42",
  timestamp: "1784900000000",
  key: Buffer.from("device-1"),
  value: Buffer.from("{broken"),
  headers: {
    tenantId: Buffer.from("tenant-1"),
    traceId: Buffer.from("019c0000-0000-7000-8000-000000000001"),
  },
  kind: "invalid_json" as const,
  message: "invalid JSON",
  failedAt: "2026-07-24T12:00:00.000Z",
};

test("builds a deterministic and tenant-aware dead-letter record", () => {
  const first = buildDeadLetterRecord(baseInput);
  const second = buildDeadLetterRecord({
    ...baseInput,
    failedAt: "2026-07-24T12:01:00.000Z",
  });

  assert.equal(first.deadLetterId, second.deadLetterId);
  assert.equal(first.tenantId, "tenant-1");
  assert.equal(first.traceId, "019c0000-0000-7000-8000-000000000001");
  assert.equal(first.payload.originalBytes, 7);
  assert.equal(first.payload.truncated, false);
  assert.equal(
    Buffer.from(first.payload.data || "", "base64").toString(),
    "{broken",
  );
});

test("bounds retained payload while hashing the complete value", () => {
  const record = buildDeadLetterRecord({
    ...baseInput,
    value: Buffer.from("0123456789"),
    maxPayloadBytes: 4,
  });

  assert.equal(record.payload.originalBytes, 10);
  assert.equal(record.payload.retainedBytes, 4);
  assert.equal(record.payload.truncated, true);
  assert.equal(
    Buffer.from(record.payload.data || "", "base64").toString(),
    "0123",
  );
  assert.match(record.payload.sha256 || "", /^[a-f0-9]{64}$/);
});

test("uses explicit unknown tenant and null payload metadata when headers/value are absent", () => {
  const record = buildDeadLetterRecord({
    ...baseInput,
    value: null,
    headers: undefined,
    kind: "null_value",
  });

  assert.equal(record.tenantId, "__unknown__");
  assert.equal(record.traceId, null);
  assert.equal(record.payload.data, null);
  assert.equal(record.payload.sha256, null);
});
