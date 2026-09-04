import type { ValidateFunction } from "ajv";
import { compileTelemetrySchemaDocument } from "./telemetry-schema";

export interface SchemaCoordinates {
  subject: string;
  id: number;
  version: number;
}

export type SchemaHeaderResult =
  | { ok: true; coordinates: SchemaCoordinates }
  | { ok: false; message: string };

export class SchemaRegistryLookupError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SchemaRegistryLookupError";
  }
}

interface RegistrySchemaVersion {
  subject: string;
  id: number;
  version: number;
  schemaType?: string;
  schema: string;
}

export class SchemaRegistryResolver {
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(
    private readonly baseUrl: string,
    readonly subject: string,
    private readonly maxEntries = 100,
    private readonly timeoutMs = 5_000,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Schema Registry cache size must be a positive integer");
    }
  }

  async preloadLatest(): Promise<SchemaCoordinates> {
    const version = await this.fetchVersion("latest");
    this.store(version, this.compile(version));
    return coordinates(version);
  }

  async resolve(
    schemaCoordinates: SchemaCoordinates,
  ): Promise<{ validate: ValidateFunction; cacheHit: boolean }> {
    if (schemaCoordinates.subject !== this.subject) {
      throw new SchemaRegistryLookupError(
        `Schema subject ${schemaCoordinates.subject} is not allowed`,
        false,
      );
    }
    const key = cacheKey(schemaCoordinates);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { validate: cached, cacheHit: true };
    }

    const version = await this.fetchVersion(schemaCoordinates.version);
    if (version.id !== schemaCoordinates.id) {
      throw new SchemaRegistryLookupError(
        `Schema ID ${schemaCoordinates.id} does not match ${this.subject} version ${schemaCoordinates.version}`,
        false,
      );
    }
    const validate = this.compile(version);
    this.store(version, validate);
    return { validate, cacheHit: false };
  }

  get size() {
    return this.cache.size;
  }

  private async fetchVersion(version: number | "latest") {
    const url = `${trimUrl(this.baseUrl)}/subjects/${encodeURIComponent(this.subject)}/versions/${version}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/vnd.schemaregistry.v1+json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SchemaRegistryLookupError(
        `Schema Registry request failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new SchemaRegistryLookupError(
        `Schema Registry returned non-JSON response with status ${response.status}`,
        true,
        response.status,
      );
    }
    if (!response.ok) {
      const message = (payload as { message?: string }).message ||
        `Schema Registry returned status ${response.status}`;
      throw new SchemaRegistryLookupError(
        message,
        response.status >= 500 || response.status === 408 || response.status === 429,
        response.status,
      );
    }
    return payload as RegistrySchemaVersion;
  }

  private compile(version: RegistrySchemaVersion) {
    if (
      version.subject !== this.subject ||
      !Number.isInteger(version.id) ||
      !Number.isInteger(version.version) ||
      (version.schemaType || "AVRO") !== "JSON"
    ) {
      throw new SchemaRegistryLookupError(
        `Registry identity or type is invalid for subject ${this.subject}`,
        false,
      );
    }
    try {
      return compileTelemetrySchemaDocument(JSON.parse(version.schema));
    } catch (error) {
      throw new SchemaRegistryLookupError(
        `Registered JSON Schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  private store(version: RegistrySchemaVersion, validate: ValidateFunction) {
    const key = cacheKey(coordinates(version));
    this.cache.delete(key);
    this.cache.set(key, validate);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export function parseSchemaCoordinates(
  headers: Record<string, unknown> | undefined,
  expectedSubject: string,
): SchemaHeaderResult {
  const subject = decodeHeader(headers?.schemaSubject);
  const id = parsePositiveInteger(decodeHeader(headers?.schemaId));
  const version = parsePositiveInteger(decodeHeader(headers?.schemaVersion));
  if (!subject || subject !== expectedSubject || !id || !version) {
    return {
      ok: false,
      message: `Invalid Schema headers; expected subject ${expectedSubject} and positive schemaId/schemaVersion`,
    };
  }
  return { ok: true, coordinates: { subject, id, version } };
}

function decodeHeader(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return null;
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function parsePositiveInteger(value: string | null) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function coordinates(version: RegistrySchemaVersion): SchemaCoordinates {
  return { subject: version.subject, id: version.id, version: version.version };
}

function cacheKey(schemaCoordinates: SchemaCoordinates) {
  return `${schemaCoordinates.subject}:${schemaCoordinates.version}:${schemaCoordinates.id}`;
}

function trimUrl(url: string) {
  return url.replace(/\/+$/, "");
}
