const registryUrl = (process.env.SCHEMA_REGISTRY_URL || "http://127.0.0.1:8081").replace(
  /\/+$/,
  "",
);
const runId =
  process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, "-");
const subject = `compat.telemetry.${runId}-value`;

const baseline = schema({
  eventId: { type: "string" },
});
const compatible = schema({
  eventId: { type: "string" },
  optionalNote: { type: "string" },
});
const breaking = schema(
  {
    eventId: { type: "string" },
    requiredSource: { type: "string" },
  },
  ["eventId", "requiredSource"],
);

async function main() {
  const startedAt = new Date().toISOString();
  await request(`/config/${encodeURIComponent(subject)}`, {
    method: "PUT",
    body: JSON.stringify({ compatibility: "BACKWARD" }),
  });

  const baselineRegistration = await register(baseline);
  const compatibleCheck = await check(compatible);
  const compatibleRegistration = compatibleCheck.is_compatible
    ? await register(compatible)
    : null;
  const breakingCheck = await check(breaking);
  const breakingRegistration = await request(
    `/subjects/${encodeURIComponent(subject)}/versions`,
    schemaRequest(breaking),
    true,
  );
  const versions = await request(`/subjects/${encodeURIComponent(subject)}/versions`);
  const config = await request(`/config/${encodeURIComponent(subject)}`);

  const assertions = {
    backward_policy_active: config.compatibilityLevel === "BACKWARD",
    baseline_registered: Number.isInteger(baselineRegistration.id),
    optional_field_compatible: compatibleCheck.is_compatible === true,
    compatible_registered_as_v2:
      Number.isInteger(compatibleRegistration?.id) &&
      JSON.stringify(versions) === JSON.stringify([1, 2]),
    required_field_incompatible: breakingCheck.is_compatible === false,
    breaking_registration_rejected: breakingRegistration.status === 409,
    no_breaking_version_created: JSON.stringify(versions) === JSON.stringify([1, 2]),
  };

  const result = {
    evidenceType: "local-schema-compatibility-smoke",
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    registry: "Confluent Schema Registry 7.9.2",
    subject,
    policy: config.compatibilityLevel,
    baselineRegistration,
    compatibleCheck,
    compatibleRegistration,
    breakingCheck,
    breakingRegistration,
    versions,
    assertions,
    passed: Object.values(assertions).every(Boolean),
    evidenceBoundary:
      "Synthetic local JSON Schema compatibility evidence; production Registry HA, ACL, TLS, and cross-region recovery are not proven.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

function schema(properties, required = ["eventId"]) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function schemaRequest(value) {
  return {
    method: "POST",
    body: JSON.stringify({ schemaType: "JSON", schema: JSON.stringify(value) }),
  };
}

function register(value) {
  return request(`/subjects/${encodeURIComponent(subject)}/versions`, schemaRequest(value));
}

function check(value) {
  return request(
    `/compatibility/subjects/${encodeURIComponent(subject)}/versions/latest?verbose=true`,
    schemaRequest(value),
  );
}

async function request(path, init = {}, allowError = false) {
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
  if (!response.ok && !allowError) {
    throw new Error(`Schema Registry ${response.status}: ${payload.message || text}`);
  }
  return allowError ? { status: response.status, ...payload } : payload;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { passed: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exit(1);
});
