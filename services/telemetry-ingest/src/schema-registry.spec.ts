import assert from "node:assert/strict";
import { createServer, IncomingMessage } from "node:http";
import test from "node:test";
import { registerJsonSchema, SchemaRegistryError } from "./schema-registry";

const schemaText = JSON.stringify({
  type: "object",
  properties: { eventId: { type: "string" } },
});

test("registers and resolves the exact JSON Schema identity", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push({ url: request.url || "", body });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/versions")) {
      response.end(JSON.stringify({ id: 17 }));
    } else {
      response.end(
        JSON.stringify({ subject: "telemetry.device.v1-value", id: 17, version: 3 }),
      );
    }
  });
  const baseUrl = await listen(server);
  try {
    const registered = await registerJsonSchema(
      baseUrl,
      "telemetry.device.v1-value",
      schemaText,
    );
    assert.deepEqual(registered, {
      subject: "telemetry.device.v1-value",
      id: 17,
      version: 3,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.schemaType, "JSON");
    assert.deepEqual(JSON.parse(String(requests[0].body.schema)), JSON.parse(schemaText));
  } finally {
    server.close();
  }
});

test("surfaces Registry compatibility failures with status and error code", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error_code: 409, message: "Schema being registered is incompatible" }));
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      registerJsonSchema(baseUrl, "telemetry.device.v1-value", schemaText),
      (error: unknown) => {
        assert.ok(error instanceof SchemaRegistryError);
        assert.equal(error.status, 409);
        assert.equal(error.errorCode, 409);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
