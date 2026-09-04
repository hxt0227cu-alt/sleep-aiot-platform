-- Layer 2 tenant isolation for health data. The migration aborts rather than
-- assigning ambiguous historical rows to an arbitrary tenant.
BEGIN;
ALTER TABLE "alarm_records" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_plans" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_routine_records" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_diaries" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_relax_records" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_reports" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "vital_signs_data" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "sleep_state_data" ADD COLUMN "tenant_id" TEXT;

UPDATE "alarm_records" r SET "tenant_id" = d."tenant_id"
FROM "devices" d WHERE r."device_id" = d."device_id";
UPDATE "sleep_reports" r SET "tenant_id" = d."tenant_id"
FROM "devices" d WHERE r."device_id" = d."device_id";
UPDATE "vital_signs_data" r SET "tenant_id" = d."tenant_id"
FROM "devices" d WHERE r."device_id" = d."device_id";
UPDATE "sleep_state_data" r SET "tenant_id" = d."tenant_id"
FROM "devices" d WHERE r."device_id" = d."device_id";
UPDATE "sleep_diaries" r SET "tenant_id" = d."tenant_id"
FROM "devices" d WHERE r."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;

WITH unique_membership AS (
  SELECT "user_id", min("tenant_id") AS "tenant_id"
  FROM "tenant_members"
  WHERE "status" = 'active'
  GROUP BY "user_id"
  HAVING count(DISTINCT "tenant_id") = 1
)
UPDATE "sleep_plans" r SET "tenant_id" = m."tenant_id"
FROM unique_membership m WHERE r."user_id" = m."user_id";

WITH unique_membership AS (
  SELECT "user_id", min("tenant_id") AS "tenant_id"
  FROM "tenant_members" WHERE "status" = 'active'
  GROUP BY "user_id" HAVING count(DISTINCT "tenant_id") = 1
)
UPDATE "sleep_routine_records" r SET "tenant_id" = m."tenant_id"
FROM unique_membership m WHERE r."user_id" = m."user_id";

WITH unique_membership AS (
  SELECT "user_id", min("tenant_id") AS "tenant_id"
  FROM "tenant_members" WHERE "status" = 'active'
  GROUP BY "user_id" HAVING count(DISTINCT "tenant_id") = 1
)
UPDATE "sleep_diaries" r SET "tenant_id" = m."tenant_id"
FROM unique_membership m WHERE r."user_id" = m."user_id" AND r."tenant_id" IS NULL;

WITH unique_membership AS (
  SELECT "user_id", min("tenant_id") AS "tenant_id"
  FROM "tenant_members" WHERE "status" = 'active'
  GROUP BY "user_id" HAVING count(DISTINCT "tenant_id") = 1
)
UPDATE "sleep_relax_records" r SET "tenant_id" = m."tenant_id"
FROM unique_membership m WHERE r."user_id" = m."user_id";

DO $$
DECLARE unresolved bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "alarm_records" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_plans" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_routine_records" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_diaries" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_relax_records" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_reports" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "vital_signs_data" WHERE "tenant_id" IS NULL) +
    (SELECT count(*) FROM "sleep_state_data" WHERE "tenant_id" IS NULL)
  INTO unresolved;
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'tenant backfill unresolved for % health rows; resolve device ownership or ambiguous user memberships before retrying', unresolved;
  END IF;
END $$;

ALTER TABLE "alarm_records" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_plans" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_routine_records" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_diaries" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_relax_records" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_reports" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "vital_signs_data" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "sleep_state_data" ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "alarm_records" ADD CONSTRAINT "alarm_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_plans" ADD CONSTRAINT "sleep_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_routine_records" ADD CONSTRAINT "sleep_routine_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_diaries" ADD CONSTRAINT "sleep_diaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_relax_records" ADD CONSTRAINT "sleep_relax_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_reports" ADD CONSTRAINT "sleep_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "vital_signs_data" ADD CONSTRAINT "vital_signs_data_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;
ALTER TABLE "sleep_state_data" ADD CONSTRAINT "sleep_state_data_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT;

CREATE INDEX "alarm_records_tenant_id_timestamp_idx" ON "alarm_records"("tenant_id", "timestamp");
CREATE INDEX "sleep_plans_tenant_id_updated_at_idx" ON "sleep_plans"("tenant_id", "updated_at");
CREATE INDEX "sleep_routine_records_tenant_id_date_idx" ON "sleep_routine_records"("tenant_id", "date");
CREATE INDEX "sleep_diaries_tenant_id_date_idx" ON "sleep_diaries"("tenant_id", "date");
CREATE INDEX "sleep_relax_records_tenant_id_completed_at_idx" ON "sleep_relax_records"("tenant_id", "completed_at");
CREATE INDEX "sleep_reports_tenant_id_report_date_idx" ON "sleep_reports"("tenant_id", "report_date");
CREATE INDEX "vital_signs_data_tenant_id_timestamp_idx" ON "vital_signs_data"("tenant_id", "timestamp");
CREATE INDEX "sleep_state_data_tenant_id_timestamp_idx" ON "sleep_state_data"("tenant_id", "timestamp");

-- Shared Agent runtime state. PostgreSQL stores state; Temporal owns dispatch.
CREATE TABLE "agent_runtime_runs" (
  "run_id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("tenant_id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("user_id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "agent_runtime_runs_tenant_status_idx" ON "agent_runtime_runs"("tenant_id", "status", "updated_at");

CREATE TABLE "agent_preference_memories" (
  "memory_id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("tenant_id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("user_id") ON DELETE CASCADE,
  "preference_key" VARCHAR(120) NOT NULL,
  "payload" JSONB NOT NULL,
  "source" VARCHAR(120) NOT NULL,
  "purpose" VARCHAR(240) NOT NULL,
  "consent_id" VARCHAR(160) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "agent_preference_memory_scope_idx" ON "agent_preference_memories"("tenant_id", "user_id", "expires_at");

CREATE TABLE "agent_workspace_artifacts" (
  "artifact_id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("tenant_id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("user_id") ON DELETE CASCADE,
  "session_id" UUID NOT NULL,
  "artifact_key" VARCHAR(160) NOT NULL,
  "artifact_type" VARCHAR(80) NOT NULL,
  "payload" JSONB NOT NULL,
  "source" VARCHAR(120) NOT NULL,
  "purpose" VARCHAR(240) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "agent_workspace_scope_idx" ON "agent_workspace_artifacts"("tenant_id", "user_id", "session_id", "expires_at");

CREATE TABLE "agent_memory_audit" (
  "audit_id" BIGSERIAL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("tenant_id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("user_id") ON DELETE CASCADE,
  "action" VARCHAR(40) NOT NULL,
  "resource_type" VARCHAR(80) NOT NULL,
  "resource_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "agent_memory_audit_scope_idx" ON "agent_memory_audit"("tenant_id", "user_id", "created_at");

COMMIT;
