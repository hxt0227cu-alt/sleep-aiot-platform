# Database migration baseline runbook

This runbook governs fresh database creation and the one-time adoption of an
existing database into the Prisma migration history. It does not authorize
production access or replace an environment-specific change review.

## Preconditions

- Use the exact application Git SHA and immutable image digest approved for the
  release.
- Record the target host/database, operator, maintenance window, backup ID, and
  change-record path outside command history containing secrets.
- Confirm `DATABASE_URL` points to the intended target and
  `SHADOW_DATABASE_URL` points to a separate, disposable empty database.
- Keep both URLs out of Git and captured logs.
- For an existing environment, complete and verify a restorable backup first.

## Fresh database

From `backend/`, set `DATABASE_URL` and run:

```powershell
npm run migration:deploy
npm run migration:status
```

Run `prisma/setup-timescaledb.sql` separately only after the TimescaleDB
extension is available and ADR-021 prerequisites are satisfied. Application
traffic remains blocked until the migration job and required extension setup
have succeeded.

The setup script selects an explicit capability mode from
`timescaledb.license`. Community/full installations create and verify the two
hypertables, three continuous aggregates, five retention policies, two
compression policies, and three refresh policies. Managed installations that
report the Apache license use `apache-core`: the two hypertables and indexes
are required, while unsupported continuous aggregates and background policies
must remain absent. Preserve the mode and object counts emitted by
`verify-timescaledb.sql`; never describe `apache-core` as full policy support.
The `timescale_capability_mode` psql variable exists for isolated compatibility
tests only and must not be used to overstate a target instance's capabilities.

Re-running `migration:deploy` must report no pending migrations. Never use
`prisma db push` to initialize or repair staging/production.

## Existing database adoption

First run the adoption command without `--apply`:

```powershell
npm run migration:adopt -- `
  --expected-host <exact-host> `
  --expected-database <exact-database> `
  --backup-evidence <backup-id-or-evidence-path> `
  --change-record <approved-change-record>
```

The command refuses a target identity mismatch, a shared target/shadow
database, an incomplete migration stack, or any schema difference. Review the
reported target, backup evidence, change record, and migration list. Only then
repeat the same command with `--apply`.

After adoption:

```powershell
npm run migration:status
npm run migration:deploy
```

Both commands must show the schema is current. Preserve redacted output with
the deployment evidence.

## Drift response

Do not bypass a failed comparison and do not call `prisma migrate resolve`
manually. Capture the redacted diff, stop the rollout, and determine whether the
target is wrong, the database has unmanaged DDL, or the repository lacks an
expand/contract migration. Reconcile through a reviewed migration and repeat
the dry run.

## Rollback and recovery

Before `--apply`, no database writes occur. After adoption or deployment, roll
back the application digest only when the migration is backward compatible. If
data/schema restoration is required, stop writers, restore the named backup to
a new database, verify it, switch the application through the approved change,
and retain the failed database for investigation. Do not delete migration rows.

RDS backup restoration and PITR are E3 gates; local PostgreSQL evidence cannot
be cited as proof that those managed-service controls work.
