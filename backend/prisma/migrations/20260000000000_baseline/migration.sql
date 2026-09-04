-- Deployment baseline for the committed application schema at 1ac9fc7.
-- TimescaleDB hypertables and policies remain in prisma/setup-timescaledb.sql.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "users" (
    "user_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT,
    "avatar_url" TEXT,
    "wechat_openid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "login_method" TEXT NOT NULL,
    "session_type" TEXT NOT NULL DEFAULT 'app',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_id" TEXT,
    "device_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "verification_codes" (
    "verification_code_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'sms',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "invalidated_at" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("verification_code_id")
);

-- CreateTable
CREATE TABLE "login_audits" (
    "audit_id" TEXT NOT NULL,
    "user_id" TEXT,
    "phone" TEXT,
    "session_id" TEXT,
    "login_method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "failure_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_audits_pkey" PRIMARY KEY ("audit_id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "setting_key" TEXT NOT NULL,
    "setting_value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "device_id" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "device_type" TEXT NOT NULL DEFAULT 'sleep_lamp',
    "firmware_version" TEXT,
    "mac_address" TEXT,
    "chip_id" TEXT,
    "psram_size" TEXT,
    "location" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_seen" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'offline',
    "tenant_id" TEXT,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "binding_code" TEXT,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarm_records" (
    "alarm_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT,
    "alarm_type" TEXT NOT NULL,
    "alarm_level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "value" DECIMAL(10,2),
    "threshold" DECIMAL(10,2),
    "timestamp" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "handled_by" TEXT,
    "handled_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "alarm_records_pkey" PRIMARY KEY ("alarm_id")
);

-- CreateTable
CREATE TABLE "alarm_configs" (
    "id" SERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "alarm_type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "threshold" DECIMAL(10,2) NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 60,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alarm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "contact_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "relationship" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("contact_id")
);

-- CreateTable
CREATE TABLE "device_configs" (
    "id" SERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "config_key" TEXT NOT NULL,
    "config_value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_versions" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "changelog" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "firmware_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "light_alarms" (
    "alarm_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "brightness_target" INTEGER NOT NULL,
    "color_temp_target" INTEGER NOT NULL,
    "ramp_minutes" INTEGER NOT NULL DEFAULT 15,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "light_alarms_pkey" PRIMARY KEY ("alarm_id")
);

-- CreateTable
CREATE TABLE "device_provision_tokens" (
    "provision_token_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_provision_tokens_pkey" PRIMARY KEY ("provision_token_id")
);

-- CreateTable
CREATE TABLE "device_binding_sessions" (
    "binding_session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "device_id" TEXT,
    "provision_token_id" TEXT,
    "binding_code" TEXT,
    "session_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "request_metadata" JSONB,
    "expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "unbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_binding_sessions_pkey" PRIMARY KEY ("binding_session_id")
);

-- CreateTable
CREATE TABLE "device_command_records" (
    "command_record_id" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "topic" TEXT NOT NULL,
    "response" JSONB,
    "error_message" TEXT,
    "timeout_ms" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_command_records_pkey" PRIMARY KEY ("command_record_id")
);

-- CreateTable
CREATE TABLE "sleep_plans" (
    "plan_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bed_time" TEXT NOT NULL,
    "sleep_duration" DOUBLE PRECISION NOT NULL,
    "wake_time" TEXT NOT NULL,
    "reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_plans_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "sleep_routine_templates" (
    "template_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sleep_routine_templates_pkey" PRIMARY KEY ("template_id")
);

-- CreateTable
CREATE TABLE "sleep_routine_records" (
    "record_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "steps_snapshot" JSONB NOT NULL DEFAULT '[]',
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_routine_records_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "sleep_diaries" (
    "diary_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT,
    "date" DATE NOT NULL,
    "bed_time" TEXT NOT NULL,
    "wake_time" TEXT NOT NULL,
    "fall_asleep_minutes" INTEGER NOT NULL,
    "quality" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_diaries_pkey" PRIMARY KEY ("diary_id")
);

-- CreateTable
CREATE TABLE "sleep_relax_records" (
    "record_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method_id" TEXT NOT NULL,
    "method_name" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_relax_records_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "sleep_reports" (
    "report_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT,
    "report_date" DATE NOT NULL,
    "sleep_score" INTEGER,
    "sleep_duration" JSONB,
    "sleep_efficiency" INTEGER,
    "sleep_latency" INTEGER,
    "awakenings" INTEGER NOT NULL DEFAULT 0,
    "sleep_structure" JSONB,
    "vital_signs" JSONB,
    "health_suggestions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_reports_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "vital_signs_data" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "heart_rate" INTEGER,
    "breathing_rate" INTEGER,
    "body_movement" DECIMAL(10,2),
    "sleep_state" TEXT,
    "sleep_score" INTEGER,
    "confidence" DECIMAL(5,2),
    "raw_data" JSONB,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "vital_signs_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_state_data" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "confidence" DECIMAL(5,2),
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "sleep_state_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_device_actions" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "execute_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "related_request_id" TEXT,
    "executed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_device_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "document_id" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT,
    "checksum" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "chunk_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "token_count" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "embedding" vector,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("chunk_id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_members" (
    "tenant_member_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("tenant_member_id")
);

-- CreateTable
CREATE TABLE "tenant_quotas" (
    "tenant_quota_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "max_users" INTEGER NOT NULL DEFAULT 10,
    "max_devices" INTEGER NOT NULL DEFAULT 20,
    "max_agent_concurrency" INTEGER NOT NULL DEFAULT 2,
    "daily_token_budget" BIGINT,
    "storage_bytes" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_quotas_pkey" PRIMARY KEY ("tenant_quota_id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "run_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "agent_type" TEXT NOT NULL,
    "workflow_version" TEXT NOT NULL DEFAULT 'v1',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "model" TEXT,
    "prompt_version" TEXT,
    "token_input" INTEGER,
    "token_output" INTEGER,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "algorithm_proposals" (
    "algorithm_proposal_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_run_id" TEXT NOT NULL,
    "proposer_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "workflow_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "cohort_criteria" JSONB NOT NULL,
    "parameter_diff" JSONB NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "primary_metric" TEXT NOT NULL,
    "guardrail_metrics" JSONB NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "canary_percentage" INTEGER NOT NULL DEFAULT 5,
    "rollback_condition" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "canary_started_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "rolled_back_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "algorithm_proposals_pkey" PRIMARY KEY ("algorithm_proposal_id")
);

-- CreateTable
CREATE TABLE "algorithm_proposal_actions" (
    "algorithm_proposal_action_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "algorithm_proposal_actions_pkey" PRIMARY KEY ("algorithm_proposal_action_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "audit_event_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "user_id" TEXT,
    "request_id" TEXT,
    "trace_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "outcome" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("audit_event_id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "outbox_event_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("outbox_event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_is_active_idx" ON "auth_sessions"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "verification_codes_phone_type_status_idx" ON "verification_codes"("phone", "type", "status");

-- CreateIndex
CREATE INDEX "verification_codes_expires_at_idx" ON "verification_codes"("expires_at");

-- CreateIndex
CREATE INDEX "login_audits_user_id_created_at_idx" ON "login_audits"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "login_audits_phone_created_at_idx" ON "login_audits"("phone", "created_at");

-- CreateIndex
CREATE INDEX "login_audits_session_id_created_at_idx" ON "login_audits"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "user_settings_user_id_idx" ON "user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_setting_key_key" ON "user_settings"("user_id", "setting_key");

-- CreateIndex
CREATE UNIQUE INDEX "devices_mac_address_key" ON "devices"("mac_address");

-- CreateIndex
CREATE INDEX "devices_mac_address_idx" ON "devices"("mac_address");

-- CreateIndex
CREATE INDEX "devices_status_idx" ON "devices"("status");

-- CreateIndex
CREATE INDEX "devices_tenant_id_status_idx" ON "devices"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "user_devices_user_id_idx" ON "user_devices"("user_id");

-- CreateIndex
CREATE INDEX "user_devices_device_id_idx" ON "user_devices"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_user_id_device_id_key" ON "user_devices"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "alarm_records_device_id_idx" ON "alarm_records"("device_id");

-- CreateIndex
CREATE INDEX "alarm_records_user_id_idx" ON "alarm_records"("user_id");

-- CreateIndex
CREATE INDEX "alarm_records_timestamp_idx" ON "alarm_records"("timestamp");

-- CreateIndex
CREATE INDEX "alarm_records_status_idx" ON "alarm_records"("status");

-- CreateIndex
CREATE INDEX "alarm_records_tenant_id_timestamp_idx" ON "alarm_records"("tenant_id", "timestamp");

-- CreateIndex
CREATE INDEX "alarm_configs_device_id_idx" ON "alarm_configs"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "alarm_configs_device_id_alarm_type_key" ON "alarm_configs"("device_id", "alarm_type");

-- CreateIndex
CREATE INDEX "emergency_contacts_user_id_idx" ON "emergency_contacts"("user_id");

-- CreateIndex
CREATE INDEX "device_configs_device_id_idx" ON "device_configs"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_configs_device_id_config_key_key" ON "device_configs"("device_id", "config_key");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_versions_version_key" ON "firmware_versions"("version");

-- CreateIndex
CREATE INDEX "firmware_versions_device_type_idx" ON "firmware_versions"("device_type");

-- CreateIndex
CREATE INDEX "firmware_versions_is_active_idx" ON "firmware_versions"("is_active");

-- CreateIndex
CREATE INDEX "light_alarms_device_id_idx" ON "light_alarms"("device_id");

-- CreateIndex
CREATE INDEX "light_alarms_user_id_idx" ON "light_alarms"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_provision_tokens_token_key" ON "device_provision_tokens"("token");

-- CreateIndex
CREATE INDEX "device_provision_tokens_user_id_idx" ON "device_provision_tokens"("user_id");

-- CreateIndex
CREATE INDEX "device_provision_tokens_device_id_idx" ON "device_provision_tokens"("device_id");

-- CreateIndex
CREATE INDEX "device_provision_tokens_status_idx" ON "device_provision_tokens"("status");

-- CreateIndex
CREATE INDEX "device_provision_tokens_expires_at_idx" ON "device_provision_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_binding_sessions_provision_token_id_key" ON "device_binding_sessions"("provision_token_id");

-- CreateIndex
CREATE INDEX "device_binding_sessions_user_id_idx" ON "device_binding_sessions"("user_id");

-- CreateIndex
CREATE INDEX "device_binding_sessions_device_id_idx" ON "device_binding_sessions"("device_id");

-- CreateIndex
CREATE INDEX "device_binding_sessions_binding_code_idx" ON "device_binding_sessions"("binding_code");

-- CreateIndex
CREATE INDEX "device_binding_sessions_session_type_idx" ON "device_binding_sessions"("session_type");

-- CreateIndex
CREATE INDEX "device_binding_sessions_status_idx" ON "device_binding_sessions"("status");

-- CreateIndex
CREATE INDEX "device_binding_sessions_expires_at_idx" ON "device_binding_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_command_records_command_id_key" ON "device_command_records"("command_id");

-- CreateIndex
CREATE INDEX "device_command_records_device_id_idx" ON "device_command_records"("device_id");

-- CreateIndex
CREATE INDEX "device_command_records_user_id_idx" ON "device_command_records"("user_id");

-- CreateIndex
CREATE INDEX "device_command_records_status_idx" ON "device_command_records"("status");

-- CreateIndex
CREATE INDEX "device_command_records_sent_at_idx" ON "device_command_records"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_plans_user_id_key" ON "sleep_plans"("user_id");

-- CreateIndex
CREATE INDEX "sleep_plans_tenant_id_updated_at_idx" ON "sleep_plans"("tenant_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_routine_templates_user_id_key" ON "sleep_routine_templates"("user_id");

-- CreateIndex
CREATE INDEX "sleep_routine_records_user_id_idx" ON "sleep_routine_records"("user_id");

-- CreateIndex
CREATE INDEX "sleep_routine_records_date_idx" ON "sleep_routine_records"("date");

-- CreateIndex
CREATE INDEX "sleep_routine_records_tenant_id_date_idx" ON "sleep_routine_records"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "sleep_diaries_user_id_idx" ON "sleep_diaries"("user_id");

-- CreateIndex
CREATE INDEX "sleep_diaries_date_idx" ON "sleep_diaries"("date");

-- CreateIndex
CREATE INDEX "sleep_diaries_device_id_idx" ON "sleep_diaries"("device_id");

-- CreateIndex
CREATE INDEX "sleep_diaries_tenant_id_date_idx" ON "sleep_diaries"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "sleep_relax_records_user_id_idx" ON "sleep_relax_records"("user_id");

-- CreateIndex
CREATE INDEX "sleep_relax_records_completed_at_idx" ON "sleep_relax_records"("completed_at");

-- CreateIndex
CREATE INDEX "sleep_relax_records_tenant_id_completed_at_idx" ON "sleep_relax_records"("tenant_id", "completed_at");

-- CreateIndex
CREATE INDEX "sleep_reports_device_id_idx" ON "sleep_reports"("device_id");

-- CreateIndex
CREATE INDEX "sleep_reports_report_date_idx" ON "sleep_reports"("report_date");

-- CreateIndex
CREATE INDEX "sleep_reports_tenant_id_report_date_idx" ON "sleep_reports"("tenant_id", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_reports_device_id_report_date_key" ON "sleep_reports"("device_id", "report_date");

-- CreateIndex
CREATE INDEX "vital_signs_data_device_id_idx" ON "vital_signs_data"("device_id");

-- CreateIndex
CREATE INDEX "vital_signs_data_timestamp_idx" ON "vital_signs_data"("timestamp");

-- CreateIndex
CREATE INDEX "vital_signs_data_tenant_id_timestamp_idx" ON "vital_signs_data"("tenant_id", "timestamp");

-- CreateIndex
CREATE INDEX "sleep_state_data_device_id_idx" ON "sleep_state_data"("device_id");

-- CreateIndex
CREATE INDEX "sleep_state_data_timestamp_idx" ON "sleep_state_data"("timestamp");

-- CreateIndex
CREATE INDEX "sleep_state_data_tenant_id_timestamp_idx" ON "sleep_state_data"("tenant_id", "timestamp");

-- CreateIndex
CREATE INDEX "scheduled_device_actions_device_id_idx" ON "scheduled_device_actions"("device_id");

-- CreateIndex
CREATE INDEX "scheduled_device_actions_user_id_idx" ON "scheduled_device_actions"("user_id");

-- CreateIndex
CREATE INDEX "scheduled_device_actions_status_execute_at_idx" ON "scheduled_device_actions"("status", "execute_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_source_path_key" ON "knowledge_documents"("source_path");

-- CreateIndex
CREATE INDEX "knowledge_chunks_document_id_idx" ON "knowledge_chunks"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_document_id_chunk_index_key" ON "knowledge_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenant_members_user_id_status_idx" ON "tenant_members"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenant_id_user_id_key" ON "tenant_members"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_quotas_tenant_id_key" ON "tenant_quotas"("tenant_id");

-- CreateIndex
CREATE INDEX "agent_runs_tenant_id_status_priority_idx" ON "agent_runs"("tenant_id", "status", "priority");

-- CreateIndex
CREATE INDEX "agent_runs_user_id_created_at_idx" ON "agent_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_status_queued_at_idx" ON "agent_runs"("status", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "algorithm_proposals_agent_run_id_key" ON "algorithm_proposals"("agent_run_id");

-- CreateIndex
CREATE INDEX "algorithm_proposals_tenant_id_status_updated_at_idx" ON "algorithm_proposals"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "algorithm_proposals_proposer_id_created_at_idx" ON "algorithm_proposals"("proposer_id", "created_at");

-- CreateIndex
CREATE INDEX "algorithm_proposal_actions_proposal_id_created_at_idx" ON "algorithm_proposal_actions"("proposal_id", "created_at");

-- CreateIndex
CREATE INDEX "algorithm_proposal_actions_tenant_id_created_at_idx" ON "algorithm_proposal_actions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_idx" ON "audit_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_user_id_created_at_idx" ON "audit_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "outbox_events_event_type_created_at_idx" ON "outbox_events"("event_type", "created_at");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audits" ADD CONSTRAINT "login_audits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audits" ADD CONSTRAINT "login_audits_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("session_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarm_records" ADD CONSTRAINT "alarm_records_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarm_records" ADD CONSTRAINT "alarm_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarm_records" ADD CONSTRAINT "alarm_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarm_configs" ADD CONSTRAINT "alarm_configs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_configs" ADD CONSTRAINT "device_configs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "light_alarms" ADD CONSTRAINT "light_alarms_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "light_alarms" ADD CONSTRAINT "light_alarms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_provision_tokens" ADD CONSTRAINT "device_provision_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_provision_tokens" ADD CONSTRAINT "device_provision_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_binding_sessions" ADD CONSTRAINT "device_binding_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_binding_sessions" ADD CONSTRAINT "device_binding_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_binding_sessions" ADD CONSTRAINT "device_binding_sessions_provision_token_id_fkey" FOREIGN KEY ("provision_token_id") REFERENCES "device_provision_tokens"("provision_token_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_command_records" ADD CONSTRAINT "device_command_records_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_command_records" ADD CONSTRAINT "device_command_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_plans" ADD CONSTRAINT "sleep_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_plans" ADD CONSTRAINT "sleep_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_routine_templates" ADD CONSTRAINT "sleep_routine_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_routine_records" ADD CONSTRAINT "sleep_routine_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_routine_records" ADD CONSTRAINT "sleep_routine_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_diaries" ADD CONSTRAINT "sleep_diaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_diaries" ADD CONSTRAINT "sleep_diaries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_diaries" ADD CONSTRAINT "sleep_diaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_relax_records" ADD CONSTRAINT "sleep_relax_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_relax_records" ADD CONSTRAINT "sleep_relax_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_reports" ADD CONSTRAINT "sleep_reports_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_reports" ADD CONSTRAINT "sleep_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_reports" ADD CONSTRAINT "sleep_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_signs_data" ADD CONSTRAINT "vital_signs_data_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_state_data" ADD CONSTRAINT "sleep_state_data_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_device_actions" ADD CONSTRAINT "scheduled_device_actions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_device_actions" ADD CONSTRAINT "scheduled_device_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_quotas" ADD CONSTRAINT "tenant_quotas_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "algorithm_proposals" ADD CONSTRAINT "algorithm_proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "algorithm_proposals" ADD CONSTRAINT "algorithm_proposals_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "algorithm_proposal_actions" ADD CONSTRAINT "algorithm_proposal_actions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "algorithm_proposals"("algorithm_proposal_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Shared Agent runtime state is migration-managed because it is consumed by
-- the Python Agent Service rather than Prisma Client.
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
