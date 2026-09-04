-- P1: 业务表租户化（ADR-017 Layer 2 扩展）
-- 10 张业务表加 tenant_id（可空）+ FK + 索引；回填遵循「尽力 + 不猜」：
--   设备链路表从 devices.tenant_id 继承；用户相关表仅当用户有【唯一】active
--   租户时回填；knowledge_chunks 从文档继承（global 文档保持 NULL）。
-- 未租户化（NULL）是合法语义（Device.tenant_id 本身可空），非数据异常。

-- 1) 加列
ALTER TABLE "user_devices"                ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "alarm_configs"               ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "device_configs"              ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "light_alarms"                ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "device_binding_sessions"     ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "device_command_records"      ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "scheduled_device_actions"    ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "emergency_contacts"          ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "sleep_routine_templates"     ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;
ALTER TABLE "knowledge_chunks"            ADD COLUMN IF NOT EXISTS "tenant_id" TEXT;

-- 2) 外键（命名与 baseline 一致：<table>_tenant_id_fkey，ON DELETE SET NULL）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_devices','alarm_configs','device_configs','light_alarms',
    'device_binding_sessions','device_command_records','scheduled_device_actions',
    'emergency_contacts','sleep_routine_templates','knowledge_chunks'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_tenant_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE SET NULL ON UPDATE CASCADE',
        t, t || '_tenant_id_fkey'
      );
    END IF;
  END LOOP;
END $$;

-- 3) 索引
CREATE INDEX IF NOT EXISTS "user_devices_tenant_id_idx"               ON "user_devices"("tenant_id");
CREATE INDEX IF NOT EXISTS "alarm_configs_tenant_id_idx"              ON "alarm_configs"("tenant_id");
CREATE INDEX IF NOT EXISTS "device_configs_tenant_id_idx"             ON "device_configs"("tenant_id");
CREATE INDEX IF NOT EXISTS "light_alarms_tenant_id_idx"               ON "light_alarms"("tenant_id");
CREATE INDEX IF NOT EXISTS "device_binding_sessions_tenant_id_idx"    ON "device_binding_sessions"("tenant_id");
CREATE INDEX IF NOT EXISTS "device_command_records_tenant_id_idx"     ON "device_command_records"("tenant_id");
CREATE INDEX IF NOT EXISTS "scheduled_device_actions_tenant_id_idx"   ON "scheduled_device_actions"("tenant_id");
CREATE INDEX IF NOT EXISTS "emergency_contacts_tenant_id_idx"         ON "emergency_contacts"("tenant_id");
CREATE INDEX IF NOT EXISTS "sleep_routine_templates_tenant_id_idx"    ON "sleep_routine_templates"("tenant_id");
CREATE INDEX IF NOT EXISTS "knowledge_chunks_tenant_id_idx"           ON "knowledge_chunks"("tenant_id");

-- 4) 回填（尽力，孤儿/未租户化保留 NULL）

-- 4.1 设备链路：从设备继承（仅设备已租户化的行）
UPDATE "user_devices" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "alarm_configs" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "device_configs" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "light_alarms" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "device_command_records" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "scheduled_device_actions" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;

-- 4.2 绑定会话：优先设备路径，其次用户唯一租户路径
UPDATE "device_binding_sessions" t SET "tenant_id" = d."tenant_id"
  FROM "devices" d WHERE t."device_id" = d."device_id" AND d."tenant_id" IS NOT NULL;
UPDATE "device_binding_sessions" t SET "tenant_id" = m."tenant_id"
  FROM "tenant_members" m
  WHERE t."tenant_id" IS NULL AND t."user_id" IS NOT NULL
    AND m."user_id" = t."user_id" AND m."status" = 'active'
    AND (SELECT count(DISTINCT "tenant_id") FROM "tenant_members"
         WHERE "user_id" = t."user_id" AND "status" = 'active') = 1;

-- 4.3 用户隐私/模板：仅用户有【唯一】active 租户时回填（多租户用户不猜，保持 NULL）
UPDATE "emergency_contacts" t SET "tenant_id" = m."tenant_id"
  FROM "tenant_members" m
  WHERE m."user_id" = t."user_id" AND m."status" = 'active'
    AND (SELECT count(DISTINCT "tenant_id") FROM "tenant_members"
         WHERE "user_id" = t."user_id" AND "status" = 'active') = 1;
UPDATE "sleep_routine_templates" t SET "tenant_id" = m."tenant_id"
  FROM "tenant_members" m
  WHERE m."user_id" = t."user_id" AND m."status" = 'active'
    AND (SELECT count(DISTINCT "tenant_id") FROM "tenant_members"
         WHERE "user_id" = t."user_id" AND "status" = 'active') = 1;

-- 4.4 知识块：从文档继承（global 文档的 chunk 保持 NULL，合法）
UPDATE "knowledge_chunks" t SET "tenant_id" = d."tenant_id"
  FROM "knowledge_documents" d
  WHERE t."document_id" = d."document_id" AND d."tenant_id" IS NOT NULL;

-- 5) 回填统计（NOTICE 报告每表仍为 NULL 的行数，供人工核对）
DO $$
DECLARE t text; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_devices','alarm_configs','device_configs','light_alarms',
    'device_binding_sessions','device_command_records','scheduled_device_actions',
    'emergency_contacts','sleep_routine_templates','knowledge_chunks'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenant_id" IS NULL', t) INTO n;
    RAISE NOTICE 'tenant backfill %: % rows remain NULL (un-tenanted, legal)', t, n;
  END LOOP;
END $$;

-- 6) P2: Device 孤儿治理——外键 SetNull → Restrict（删租户必须先解绑/迁移设备）
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_tenant_id_fkey";
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
