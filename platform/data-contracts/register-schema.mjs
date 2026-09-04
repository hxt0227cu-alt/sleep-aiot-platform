import { readFile } from "node:fs/promises";

const registryUrl = required("SCHEMA_REGISTRY_URL").replace(/\/+$/, "");
const subject = process.env.SCHEMA_REGISTRY_SUBJECT || "telemetry.device.v1-value";
const schemaPath = required("SCHEMA_PATH");
const compatibility = process.env.SCHEMA_COMPATIBILITY || "BACKWARD";
const schema = JSON.stringify(JSON.parse(await readFile(schemaPath, "utf8")));
const subjectPath = encodeURIComponent(subject);

await request(`/config/${subjectPath}`, {
  method: "PUT",
  body: JSON.stringify({ compatibility }),
});
const registration = await request(`/subjects/${subjectPath}/versions`, {
  method: "POST",
  body: JSON.stringify({ schemaType: "JSON", schema }),
});
const identity = await request(`/subjects/${subjectPath}`, {
  method: "POST",
  body: JSON.stringify({ schemaType: "JSON", schema }),
});

if (registration.id !== identity.id || identity.subject !== subject) {
  throw new Error(`Registry returned inconsistent identity for ${subject}`);
}

console.log(JSON.stringify({
  subject,
  id: identity.id,
  version: identity.version,
  compatibility,
}));

async function request(path, init) {
  const response = await fetch(`${registryUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.schemaregistry.v1+json",
      "content-type": "application/vnd.schemaregistry.v1+json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Schema Registry ${response.status}: ${payload.message || text}`);
  }
  return payload;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
