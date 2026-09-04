import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const composeFile = resolve(workspace, 'platform/local/docker-compose.enterprise.yml');
const envFile = resolve(workspace, 'platform/local/.env.example');
const runId = (process.env.EVIDENCE_RUN_ID || new Date().toISOString().replaceAll(/[:.]/g, '-')).slice(0, 80);
const outputPath = resolve(
  workspace,
  process.env.EVIDENCE_OUTPUT || `202607worklog/performance/raw/${runId}-agent-feature-service.json`,
);
const token = required('FEATURE_SERVICE_TOKEN');
const featureUrl = process.env.FEATURE_SERVICE_URL || 'http://127.0.0.1:8101';
const agentUrl = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8000';
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const unknownTenant = '33333333-3333-4333-8333-333333333333';
const deviceId = 'shared-device';

let featureStopped = false;
let result = {
  evidenceType: 'local-agent-feature-service-integration-smoke',
  evidenceBoundary: 'Local synthetic integration and dependency-failure evidence; not throughput, HA, or cloud-capacity evidence.',
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  passed: false,
};

try {
  seedAgentScopeFixtures();
  compose(['restart', 'feature-service']);
  await waitForReady(`${featureUrl}/health/ready`, 30_000, 'Feature Service after cache-reset restart');
  await waitForReady(`${agentUrl}/health/ready`, 30_000, 'Agent Service');

  const environment = {
    featureServiceImageId: docker(['image', 'inspect', '--format', '{{.Id}}', 'local-feature-service']).trim(),
    agentServiceImageId: docker(['image', 'inspect', '--format', '{{.Id}}', 'local-agent-service']).trim(),
    featureServiceContainerId: compose(['ps', '-q', 'feature-service']).trim(),
    agentServiceContainerId: compose(['ps', '-q', 'agent-service']).trim(),
    gitHead: commandOrNull('git', ['rev-parse', 'HEAD']),
    workspaceDirty: Boolean(commandOrNull('git', ['status', '--porcelain'])),
    featureProvider: 'service',
  };

  const featureCalls = {
    tenantAFirst: await featureRequest(tenantA),
    tenantASecond: await featureRequest(tenantA),
    tenantBFirst: await featureRequest(tenantB),
    tenantBSecond: await featureRequest(tenantB),
    unknownTenant: await featureRequest(unknownTenant),
    badCredential: await featureRequest(tenantA, 'intentionally-invalid-smoke-token'),
  };
  const metricsBeforeOutage = await textFetch(`${featureUrl}/metrics`);

  const normalAgent = await createAndWaitForAgentRun({
    tenantId: tenantA,
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workflowVersion: 'v1-feature-service-smoke',
    question: 'Analyze the latest seven-day sleep features.',
  });
  const wrongTenantRead = await fetchWithTimeout(`${agentUrl}/v1/runs/${normalAgent.run.run_id}`, {
    headers: { 'x-tenant-id': tenantB },
  });

  compose(['stop', 'feature-service']);
  featureStopped = true;
  const degradedAgent = await createAndWaitForAgentRun({
    tenantId: tenantA,
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workflowVersion: 'v1-feature-outage-smoke',
    question: 'Validate behavior while the feature dependency is unavailable.',
  });
  compose(['start', 'feature-service']);
  featureStopped = false;
  const restoredReadiness = await waitForReady(
    `${featureUrl}/health/ready`,
    30_000,
    'Feature Service recovery',
  );

  const normalFeatureResult = toolResult(normalAgent.run, 'get_sleep_features');
  const degradedFeatureResult = toolResult(degradedAgent.run, 'get_sleep_features');
  const assertions = {
    tenant_a_first_is_repository_miss:
      featureCalls.tenantAFirst.status === 200 && featureCalls.tenantAFirst.body.cacheHit === false,
    tenant_a_second_is_cache_hit:
      featureCalls.tenantASecond.status === 200 && featureCalls.tenantASecond.body.cacheHit === true,
    tenant_a_average_is_70: featureCalls.tenantAFirst.body.avgHeartRate === 70,
    tenant_b_first_is_repository_miss:
      featureCalls.tenantBFirst.status === 200 && featureCalls.tenantBFirst.body.cacheHit === false,
    tenant_b_second_is_cache_hit:
      featureCalls.tenantBSecond.status === 200 && featureCalls.tenantBSecond.body.cacheHit === true,
    tenant_b_average_is_95: featureCalls.tenantBFirst.body.avgHeartRate === 95,
    shared_device_cache_is_tenant_scoped:
      featureCalls.tenantASecond.body.tenantId === tenantA &&
      featureCalls.tenantBSecond.body.tenantId === tenantB &&
      featureCalls.tenantASecond.body.avgHeartRate !== featureCalls.tenantBSecond.body.avgHeartRate,
    unknown_tenant_is_not_found: featureCalls.unknownTenant.status === 404,
    bad_service_credential_is_rejected: featureCalls.badCredential.status === 401,
    feature_metrics_record_hits: metricValue(metricsBeforeOutage, 'sleep_feature_cache_requests_total', 'result="hit"') >= 2,
    feature_metrics_record_misses: metricValue(metricsBeforeOutage, 'sleep_feature_cache_requests_total', 'result="miss"') >= 3,
    normal_agent_succeeded: normalAgent.run.status === 'succeeded',
    normal_agent_uses_software_evidence: normalAgent.run.output?.evidence === 'software',
    normal_agent_uses_device_ads:
      normalFeatureResult.source === 'ads_agent_device_sleep_features' && normalFeatureResult.avgHeartRate === 70,
    wrong_tenant_cannot_read_agent_run: wrongTenantRead.status === 404,
    dependency_outage_degrades_explicitly:
      degradedAgent.run.status === 'succeeded' && degradedAgent.run.output?.evidence === 'degraded',
    degraded_result_has_no_fabricated_sleep_score: !Object.hasOwn(degradedFeatureResult, 'sleepScore'),
    degraded_result_has_no_fabricated_deep_sleep_ratio: !Object.hasOwn(degradedFeatureResult, 'deepSleepRatio'),
    degraded_result_identifies_dependency_failure:
      degradedFeatureResult.source === 'deterministic-degraded' &&
      degradedFeatureResult.reason === 'sleep_features_temporarily_unavailable',
    feature_service_recovered: restoredReadiness.status === 'ready',
  };
  const passed = Object.values(assertions).every(Boolean);

  result = {
    ...result,
    status: passed ? 'passed' : 'failed',
    passed,
    finishedAt: new Date().toISOString(),
    environment,
    workload: {
      tenants: [tenantA, tenantB],
      sharedDeviceId: deviceId,
      featureRequests: 6,
      agentRuns: 2,
      injectedFault: 'feature-service process stopped during one Agent Run',
    },
    timingsMs: {
      featureRequests: Object.fromEntries(
        Object.entries(featureCalls).map(([name, call]) => [name, call.durationMs]),
      ),
      normalAgentCreate: normalAgent.createDurationMs,
      normalAgentTerminal: normalAgent.terminalDurationMs,
      degradedAgentCreate: degradedAgent.createDurationMs,
      degradedAgentTerminal: degradedAgent.terminalDurationMs,
    },
    featureCalls,
    featureMetricsBeforeOutage: relevantMetrics(metricsBeforeOutage),
    normalAgent: normalAgent.run,
    wrongTenantReadStatus: wrongTenantRead.status,
    degradedAgent: degradedAgent.run,
    restoredReadiness,
    assertions,
  };
  assert.equal(passed, true, 'one or more Agent/Feature Service integration assertions failed');
} catch (error) {
  result = {
    ...result,
    status: 'failed',
    passed: false,
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
  };
  process.exitCode = 1;
} finally {
  if (featureStopped) {
    try {
      compose(['start', 'feature-service']);
      await waitForReady(`${featureUrl}/health/ready`, 30_000, 'Feature Service final recovery');
    } catch (recoveryError) {
      result.recoveryError = recoveryError instanceof Error ? recoveryError.stack : String(recoveryError);
      process.exitCode = 1;
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, runId, status: result.status, passed: result.passed }, null, 2));
}

async function featureRequest(tenantId, credential = token) {
  const started = performance.now();
  const request = () => fetchWithTimeout(
    `${featureUrl}/v1/features/sleep/${deviceId}?window_days=7`,
    {
      headers: {
        authorization: `Bearer ${credential}`,
        'x-tenant-id': tenantId,
      },
    },
  );
  const { response, attempts } = await retryNetworkRequest(request, 5, 250);
  const body = await response.json();
  return { status: response.status, attempts, durationMs: rounded(performance.now() - started), body };
}

function seedAgentScopeFixtures() {
  const sql = `
    INSERT INTO tenants (tenant_id, name, status, created_at, updated_at)
    VALUES
      ('${tenantA}', 'Synthetic tenant A', 'active', now(), now()),
      ('${tenantB}', 'Synthetic tenant B', 'active', now(), now())
    ON CONFLICT (tenant_id) DO NOTHING;
    INSERT INTO users (user_id, phone, password_hash, status, created_at, updated_at)
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-agent-a', 'not-a-real-credential', 'active', now(), now()),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'synthetic-agent-b', 'not-a-real-credential', 'active', now(), now())
    ON CONFLICT (user_id) DO NOTHING;
  `;
  compose(['exec', '-T', 'postgres', 'psql', '-U', 'sleep', '-d', 'sleep', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

async function createAndWaitForAgentRun({ tenantId, userId, workflowVersion, question }) {
  const createStarted = performance.now();
  const response = await fetchWithTimeout(`${agentUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      agent_type: 'sleep_analysis',
      workflow_version: workflowVersion,
      input: { device_id: deviceId, allowed_device_ids: [deviceId], question },
    }),
  });
  const created = await response.json();
  assert.equal(response.status, 202, `Agent create returned ${response.status}: ${JSON.stringify(created)}`);
  const createDurationMs = rounded(performance.now() - createStarted);
  const terminalStarted = performance.now();
  const run = await waitFor(async () => {
    const current = await fetchWithTimeout(`${agentUrl}/v1/runs/${created.run_id}`, {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!current.ok) throw new Error(`Agent read returned ${current.status}: ${await current.text()}`);
    const body = await current.json();
    return ['succeeded', 'failed', 'cancelled'].includes(body.status) ? body : null;
  }, 15_000, `Agent Run ${created.run_id} terminal state`, 100);
  return {
    createStatus: response.status,
    createDurationMs,
    terminalDurationMs: rounded(performance.now() - terminalStarted),
    run,
  };
}

function toolResult(run, name) {
  const entry = run.output?.toolResults?.find(item => item.tool === name);
  assert(entry, `${name} result is missing from Agent Run ${run.run_id}`);
  return entry.result;
}

async function waitForReady(url, timeoutMs, description) {
  return waitFor(async () => {
    const response = await fetchWithTimeout(url, {}, 2_000).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json();
    return body.status === 'ready' ? body : null;
  }, timeoutMs, description, 500);
}

async function waitFor(check, timeoutMs, description, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function textFetch(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.text();
}

function metricValue(metrics, name, labels) {
  const line = metrics.split(/\r?\n/).find(item => item.startsWith(`${name}{${labels}} `));
  return line ? Number(line.split(/\s+/).at(-1)) : 0;
}

function relevantMetrics(metrics) {
  return metrics.split(/\r?\n/).filter(line =>
    line.startsWith('sleep_feature_requests_total') ||
    line.startsWith('sleep_feature_cache_requests_total') ||
    line.startsWith('sleep_feature_query_seconds_') ||
    line.startsWith('sleep_feature_age_seconds') ||
    line.startsWith('sleep_feature_cache_entries'),
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function retryNetworkRequest(request, maxAttempts, delayMs) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { response: await request(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
      }
    }
  }
  throw lastError;
}

function compose(args) {
  return command('docker', ['compose', '--env-file', envFile, '-f', composeFile, '--profile', 'data-platform', ...args]);
}

function docker(args) {
  return command('docker', args);
}

function command(executable, args) {
  const run = spawnSync(executable, args, { cwd: workspace, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed (${run.status}): ${run.stderr || run.stdout}`);
  }
  return run.stdout || '';
}

function commandOrNull(executable, args) {
  const run = spawnSync(executable, args, { cwd: workspace, encoding: 'utf8' });
  return run.status === 0 ? (run.stdout || '').trim() || null : null;
}

function required(name) {
  const value = process.env[name];
  assert(value, `${name} is required and is never written to evidence`);
  return value;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}
