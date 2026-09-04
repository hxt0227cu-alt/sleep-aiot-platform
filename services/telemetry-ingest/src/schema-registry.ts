export interface RegisteredSchema {
  subject: string;
  id: number;
  version: number;
}

export class SchemaRegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = "SchemaRegistryError";
  }
}

export async function registerJsonSchema(
  baseUrl: string,
  subject: string,
  schemaText: string,
  timeoutMs = 5_000,
): Promise<RegisteredSchema> {
  const schema = JSON.stringify(JSON.parse(schemaText));
  const body = { schemaType: "JSON", schema };
  const subjectPath = encodeURIComponent(subject);

  const registration = await requestJson<{ id: number }>(
    `${trimUrl(baseUrl)}/subjects/${subjectPath}/versions`,
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  );
  const lookup = await requestJson<{
    subject: string;
    id: number;
    version: number;
  }>(
    `${trimUrl(baseUrl)}/subjects/${subjectPath}`,
    { method: "POST", body: JSON.stringify(body) },
    timeoutMs,
  );

  if (
    registration.id !== lookup.id ||
    lookup.subject !== subject ||
    !Number.isInteger(lookup.version) ||
    lookup.version < 1
  ) {
    throw new SchemaRegistryError(
      `Schema Registry returned inconsistent identity for subject ${subject}`,
    );
  }

  return { subject, id: lookup.id, version: lookup.version };
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.schemaregistry.v1+json",
        "content-type": "application/vnd.schemaregistry.v1+json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SchemaRegistryError(
      `Schema Registry request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new SchemaRegistryError(
      `Schema Registry returned non-JSON response with status ${response.status}`,
      response.status,
    );
  }
  if (!response.ok) {
    const errorPayload = payload as { error_code?: number; message?: string };
    throw new SchemaRegistryError(
      errorPayload.message || `Schema Registry returned status ${response.status}`,
      response.status,
      errorPayload.error_code,
    );
  }
  return payload as T;
}

function trimUrl(url: string) {
  return url.replace(/\/+$/, "");
}
