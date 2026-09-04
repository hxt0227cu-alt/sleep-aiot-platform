import { createHash } from "crypto";
import type { PoisonKind } from "./telemetry-event";

export interface DeadLetterInput {
  topic: string;
  partition: number;
  offset: string;
  timestamp: string;
  key: Buffer | null;
  value: Buffer | null;
  headers?: Record<string, unknown>;
  kind: PoisonKind;
  message: string;
  validationErrors?: unknown[];
  failedAt?: string;
  maxPayloadBytes?: number;
}

export interface DeadLetterRecord {
  deadLetterId: string;
  schemaVersion: 1;
  tenantId: string;
  traceId: string | null;
  failedAt: string;
  source: {
    topic: string;
    partition: number;
    offset: string;
    timestamp: string;
    keyBase64: string | null;
    headersBase64: Record<string, string | string[] | null>;
  };
  payload: {
    encoding: "base64";
    data: string | null;
    originalBytes: number;
    retainedBytes: number;
    truncated: boolean;
    sha256: string | null;
  };
  error: {
    kind: PoisonKind;
    message: string;
    validationErrors?: unknown[];
  };
}

export function buildDeadLetterRecord(
  input: DeadLetterInput,
): DeadLetterRecord {
  const maxPayloadBytes = input.maxPayloadBytes ?? 256 * 1024;
  const payload = input.value;
  const retained = payload?.subarray(0, maxPayloadBytes) ?? null;
  const sourceId = `${input.topic}\u0000${input.partition}\u0000${input.offset}`;
  const headersBase64 = encodeHeaders(input.headers || {});

  return {
    deadLetterId: createHash("sha256").update(sourceId).digest("hex"),
    schemaVersion: 1,
    tenantId: decodeHeader(input.headers?.tenantId) || "__unknown__",
    traceId: decodeHeader(input.headers?.traceId),
    failedAt: input.failedAt || new Date().toISOString(),
    source: {
      topic: input.topic,
      partition: input.partition,
      offset: input.offset,
      timestamp: input.timestamp,
      keyBase64: input.key?.toString("base64") ?? null,
      headersBase64,
    },
    payload: {
      encoding: "base64",
      data: retained?.toString("base64") ?? null,
      originalBytes: payload?.length ?? 0,
      retainedBytes: retained?.length ?? 0,
      truncated: Boolean(payload && payload.length > maxPayloadBytes),
      sha256: payload
        ? createHash("sha256").update(payload).digest("hex")
        : null,
    },
    error: {
      kind: input.kind,
      message: input.message,
      ...(input.validationErrors?.length
        ? { validationErrors: input.validationErrors }
        : {}),
    },
  };
}

function encodeHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, encodeHeader(value)]),
  );
}

function encodeHeader(value: unknown): string | string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((item) => encodeOne(item));
  return encodeOne(value);
}

function encodeOne(value: unknown): string {
  return (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString(
    "base64",
  );
}

function decodeHeader(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return null;
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}
