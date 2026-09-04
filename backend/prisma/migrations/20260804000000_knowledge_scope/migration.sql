ALTER TABLE "knowledge_documents"
  ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;

ALTER TABLE "knowledge_documents"
  DROP CONSTRAINT IF EXISTS "knowledge_documents_source_path_key";

ALTER TABLE "knowledge_documents"
  DROP CONSTRAINT IF EXISTS "knowledge_documents_scope_check";

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_scope_check"
  CHECK (
    ("scope" = 'global' AND "tenant_id" IS NULL) OR
    ("scope" = 'tenant' AND "tenant_id" IS NOT NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_documents_tenant_id_fkey'
  ) THEN
    ALTER TABLE "knowledge_documents"
      ADD CONSTRAINT "knowledge_documents_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_global_source_key"
  ON "knowledge_documents"("source_path")
  WHERE "scope" = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_tenant_source_key"
  ON "knowledge_documents"("tenant_id", "source_path")
  WHERE "scope" = 'tenant';

CREATE INDEX IF NOT EXISTS "knowledge_documents_scope_tenant_idx"
  ON "knowledge_documents"("scope", "tenant_id");
