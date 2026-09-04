import type { ErrorObject, ValidateFunction } from "ajv";

export interface TelemetryEvent {
  eventType: "device.telemetry.received";
  eventId: string;
  traceId: string;
  tenantId: string;
  deviceId: string;
  schemaVersion: 1;
  occurredAt: string;
  receivedAt: string;
  sequence?: number;
  heartRate?: number;
  breathingRate?: number;
  bodyMovement?: number;
  sleepState?: string;
  confidence?: number;
}

export type PoisonKind =
  | "null_value"
  | "invalid_json"
  | "schema_validation"
  | "schema_header"
  | "unknown_schema"
  | "partition_key";

export type PartitionKeyValidationResult =
  | { ok: true }
  | { ok: false; kind: "partition_key"; message: string };

export type TelemetryDecodeResult =
  | { ok: true; event: TelemetryEvent }
  | {
      ok: false;
      kind: PoisonKind;
      message: string;
      validationErrors?: Array<
        Pick<ErrorObject, "instancePath" | "keyword" | "message" | "params">
      >;
    };

export function decodeTelemetryEvent(
  value: Buffer | null,
  validate: ValidateFunction,
): TelemetryDecodeResult {
  if (!value) {
    return {
      ok: false,
      kind: "null_value",
      message: "Kafka message value is null",
    };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(value.toString("utf8"));
  } catch {
    return {
      ok: false,
      kind: "invalid_json",
      message: "Kafka message value is not valid JSON",
    };
  }

  if (!validate(candidate)) {
    return {
      ok: false,
      kind: "schema_validation",
      message: "Kafka message does not match device-telemetry-received.v1",
      validationErrors: (validate.errors || []).map(
        ({ instancePath, keyword, message, params }) => ({
          instancePath,
          keyword,
          message,
          params,
        }),
      ),
    };
  }

  return { ok: true, event: candidate as TelemetryEvent };
}

export function validateDevicePartitionKey(
  key: Buffer | null,
  deviceId: string,
): PartitionKeyValidationResult {
  if (!key) {
    return {
      ok: false,
      kind: "partition_key",
      message: "Kafka message key is required and must equal payload deviceId",
    };
  }

  if (!key.equals(Buffer.from(deviceId, "utf8"))) {
    return {
      ok: false,
      kind: "partition_key",
      message: "Kafka message key does not equal payload deviceId",
    };
  }

  return { ok: true };
}
