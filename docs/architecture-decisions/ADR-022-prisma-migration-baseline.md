# ADR-022: Prisma migration baseline and existing-database adoption

Status: Accepted

Date: 2026-08-03

Governed by ADR-012. Extends ADR-016 and ADR-021.

## Context

The deployment job runs `prisma migrate deploy`, but the repository previously
mixed flat SQL files and two partial Prisma migrations. An empty database could
not be built to the complete application schema, while an existing database had
no guarded path into Prisma migration history. Marking migrations as applied
without comparing the actual schema would hide drift and make later deploys
unsafe.

## Decision

`backend/prisma/migrations/` is the sole Prisma deployment authority. Its first
migration is `20260000000000_baseline`, which describes the complete committed
application schema and the migration-managed Agent runtime tables. Historical
flat SQL and superseded partial migrations remain under
`backend/prisma/migration-history/pre-baseline/` for audit only and must never be
replayed after the baseline.

Fresh databases are created only with `prisma migrate deploy`. `prisma db push`
is not an environment bootstrap or repair mechanism.

An existing database may enter the migration history only through
`backend/scripts/adopt-migration-baseline.cjs`. Adoption requires all of the
following:

- an explicit expected host and database name;
- a separate shadow database;
- backup evidence and a change-record reference;
- a zero-diff comparison between the live schema and the complete migration
  stack;
- an explicit `--apply` invocation after reviewing the dry run.

Any schema difference is a blocking condition. The tool must fail before
writing `_prisma_migrations`; operators must reconcile the database through a
reviewed expand/contract migration or restore the expected database instead of
overriding the comparison.

TimescaleDB extension-specific hypertables, continuous aggregates, and policies
remain governed by ADR-021 and `backend/prisma/setup-timescaledb.sql`. They are
not duplicated in the Prisma baseline.

## Consequences

- Empty and adopted databases converge on one auditable migration stack.
- Existing environments require a backup, a change record, a shadow database,
  and an exact schema match before adoption.
- Legacy SQL remains available for incident analysis without being executable
  by Prisma.
- The initial adoption is deliberately operationally heavier than marking a
  migration manually.
- This local decision does not prove RDS compatibility, PITR, ACK job execution,
  or production data migration. Those require verified production evidence.

## Rollback

Before adoption, revert this repository change. After adoption, do not edit or
delete migration history: stop the rollout, restore the captured pre-adoption
backup, and redeploy the previous application digest. A failed dry run requires
no database rollback because it performs no writes.

## Verification

Acceptance requires four isolated PostgreSQL checks: fresh deployment, repeated
deployment, compatible history-free adoption, and drift rejection with no
`_prisma_migrations` table created. Results are recorded in the project's internal change log
(not shipped with this public repository).
