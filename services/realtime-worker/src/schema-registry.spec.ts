import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  parseSchemaCoordinates,
  SchemaRegistryLookupError,
  SchemaRegistryResolver,
} from "./schema-registry";

const subject = "telemetry.device.v1-value";
const jsonSchema = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["eventId"],
  properties: { eventId: { type: "string" } },
});

test("parses subject-bound positive Schema coordinates", () => {
  assert.deepEqual(
    parseSchemaCoordinates(
      {
        schemaSubject: Buffer.from(subject),
        schemaId: Buffer.from("17"),
        schemaVersion: Buffer.from("3"),
      },
      subject,
    ),
    { ok: true, coordinates: { subject, id: 17, version: 3 } },
  );
});

test("rejects missing, malformed, or cross-subject Schema headers", () => {
  assert.equal(parseSchemaCoordinates(undefined, subject).ok, false);
  assert.equal(
    parseSchemaCoordinates(
      { schemaSubject: "other-value", schemaId: "17", schemaVersion: "3" },
      subject,
    ).ok,
    false,
  );
  assert.equal(
    parseSchemaCoordinates(
      { schemaSubject: subject, schemaId: "0", schemaVersion: "3x" },
      subject,
    ).ok,
    false,
  );
});

test("preloads latest and serves the same identity from cache", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(registryVersion(17, 3)));
  });
  const baseUrl = await listen(server);
  try {
    const resolver = new SchemaRegistryResolver(baseUrl, subject, 2);
    assert.deepEqual(await resolver.preloadLatest(), { subject, id: 17, version: 3 });
    const resolved = await resolver.resolve({ subject, id: 17, version: 3 });
    assert.equal(resolved.cacheHit, true);
    assert.equal(resolved.validate({ eventId: "event-1" }), true);
    assert.equal(requests, 1);
    assert.equal(resolver.size, 1);
  } finally {
    server.close();
  }
});

test("rejects an ID that is not bound to the declared subject version", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(registryVersion(22, 4)));
  });
  const baseUrl = await listen(server);
  try {
    const resolver = new SchemaRegistryResolver(baseUrl, subject);
    await assert.rejects(
      resolver.resolve({ subject, id: 999, version: 4 }),
      (error: unknown) => {
        assert.ok(error instanceof SchemaRegistryLookupError);
        assert.equal(error.transient, false);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("classifies Registry 5xx as transient infrastructure failure", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error_code: 50001, message: "registry unavailable" }));
  });
  const baseUrl = await listen(server);
  try {
    const resolver = new SchemaRegistryResolver(baseUrl, subject);
    await assert.rejects(
      resolver.resolve({ subject, id: 17, version: 3 }),
      (error: unknown) => {
        assert.ok(error instanceof SchemaRegistryLookupError);
        assert.equal(error.transient, true);
        assert.equal(error.status, 503);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

function registryVersion(id: number, version: number) {
  return { subject, id, version, schemaType: "JSON", schema: jsonSchema };
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
