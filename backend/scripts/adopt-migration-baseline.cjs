const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = resolve(__dirname, '..');
const schemaPath = resolve(backendRoot, 'prisma/schema.prisma');
const migrationsPath = resolve(backendRoot, 'prisma/migrations');
const prismaCli = require.resolve('prisma/build/index.js', { paths: [backendRoot] });
const args = parseArgs(process.argv.slice(2));

const databaseUrl = requiredEnv('DATABASE_URL');
const shadowDatabaseUrl = requiredEnv('SHADOW_DATABASE_URL');
const target = parsePostgresUrl(databaseUrl, 'DATABASE_URL');
const shadow = parsePostgresUrl(shadowDatabaseUrl, 'SHADOW_DATABASE_URL');

if (target.hostname !== args.expectedHost || target.database !== args.expectedDatabase) {
  fail(
    `target identity mismatch: expected ${args.expectedHost}/${args.expectedDatabase}, ` +
      `received ${target.hostname}/${target.database}`,
  );
}
if (target.hostname === shadow.hostname && target.database === shadow.database) {
  fail('SHADOW_DATABASE_URL must identify a different database from DATABASE_URL');
}

const migrationNames = readdirSync(migrationsPath, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(entry.name))
  .map(entry => entry.name)
  .sort();
if (migrationNames[0] !== '20260000000000_baseline') {
  fail('the deploy migration stack must start with 20260000000000_baseline');
}

const diff = runPrisma(
  [
    'migrate',
    'diff',
    '--from-schema-datasource',
    schemaPath,
    '--to-migrations',
    migrationsPath,
    '--shadow-database-url',
    shadowDatabaseUrl,
    '--exit-code',
  ],
  [databaseUrl, shadowDatabaseUrl],
  [0, 2],
);
if (diff.status === 2) {
  const detail = (diff.stdout || diff.stderr || 'schema drift detected').trim();
  fail(`existing database does not match the deploy migration stack:\n${redact(detail, [databaseUrl, shadowDatabaseUrl])}`);
}

console.log(`Schema comparison passed for ${target.hostname}/${target.database}.`);
console.log(`Backup evidence: ${args.backupEvidence}`);
console.log(`Change record: ${args.changeRecord}`);
console.log(`Migrations to record as already applied: ${migrationNames.join(', ')}`);

if (!args.apply) {
  console.log('Dry run only. Re-run with --apply after operator review.');
  process.exit(0);
}

for (const migrationName of migrationNames) {
  runPrisma(
    ['migrate', 'resolve', '--applied', migrationName, '--schema', schemaPath],
    [databaseUrl, shadowDatabaseUrl],
    [0],
  );
}
runPrisma(['migrate', 'deploy', '--schema', schemaPath], [databaseUrl, shadowDatabaseUrl], [0]);
console.log(`Migration baseline adoption completed for ${target.hostname}/${target.database}.`);

function parseArgs(input) {
  const values = { apply: false };
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === '--apply') {
      values.apply = true;
      continue;
    }
    const key = {
      '--expected-host': 'expectedHost',
      '--expected-database': 'expectedDatabase',
      '--backup-evidence': 'backupEvidence',
      '--change-record': 'changeRecord',
    }[argument];
    if (!key || !input[index + 1]) fail(`unknown or incomplete argument: ${argument}`);
    values[key] = input[index + 1].trim();
    index += 1;
  }
  for (const key of ['expectedHost', 'expectedDatabase', 'backupEvidence', 'changeRecord']) {
    if (!values[key]) fail(`missing required argument for ${key}`);
  }
  return values;
}

function parsePostgresUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is not a valid URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail(`${name} must use PostgreSQL`);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) fail(`${name} must include a host and database name`);
  return { hostname: parsed.hostname, database };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function runPrisma(prismaArgs, secrets, allowedStatuses) {
  const result = spawnSync(process.execPath, [prismaCli, ...prismaArgs], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) fail(result.error.message);
  if (!allowedStatuses.includes(result.status)) {
    const detail = redact((result.stderr || result.stdout || '').trim(), secrets);
    fail(`Prisma command failed with exit ${result.status}: ${detail}`);
  }
  return result;
}

function redact(value, secrets) {
  return secrets.reduce((result, secret) => result.split(secret).join('<redacted-database-url>'), value);
}

function fail(message) {
  console.error(`Baseline adoption refused: ${message}`);
  process.exit(1);
}
