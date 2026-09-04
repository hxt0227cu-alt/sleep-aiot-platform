-- ============================================================
-- 安全合规专项迁移
-- ============================================================
-- 包含：设备证书表、CA 信息表、统一审计表、
--       租户配额表、数据主体请求表、幂等事件表
-- ============================================================

-- ============================================================
-- 1. 设备证书表
-- ============================================================

CREATE TABLE IF NOT EXISTS device_certificates (
    id              SERIAL PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    tenant_id       VARCHAR(64),
    serial_number   VARCHAR(64) NOT NULL UNIQUE,
    certificate_pem TEXT NOT NULL,
    subject         VARCHAR(256) NOT NULL,
    issuer          VARCHAR(256) NOT NULL,
    ca_id           VARCHAR(64) NOT NULL,
    not_before      TIMESTAMPTZ NOT NULL,
    not_after       TIMESTAMPTZ NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'valid', -- valid / revoked / expired
    revoked_at      TIMESTAMPTZ,
    revocation_reason VARCHAR(32),
    fingerprint     VARCHAR(128),
    key_type        VARCHAR(32) DEFAULT 'ECDSA-P256',
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_certificates_device ON device_certificates (device_id);
CREATE INDEX IF NOT EXISTS idx_device_certificates_status ON device_certificates (status);
CREATE INDEX IF NOT EXISTS idx_device_certificates_expiry ON device_certificates (not_after) WHERE status = 'valid';
CREATE INDEX IF NOT EXISTS idx_device_certificates_tenant ON device_certificates (tenant_id);

-- ============================================================
-- 2. CA 信息表
-- ============================================================

CREATE TABLE IF NOT EXISTS ca_information (
    id              SERIAL PRIMARY KEY,
    ca_id           VARCHAR(64) NOT NULL UNIQUE,
    ca_type         VARCHAR(16) NOT NULL, -- root / intermediate
    certificate_pem TEXT NOT NULL,
    subject         VARCHAR(256) NOT NULL,
    serial_number   VARCHAR(64) NOT NULL,
    parent_ca_id    VARCHAR(64),
    not_before      TIMESTAMPTZ NOT NULL,
    not_after       TIMESTAMPTZ NOT NULL,
    kms_key_id      VARCHAR(128),
    key_type        VARCHAR(32) DEFAULT 'ECDSA-P256',
    is_online       BOOLEAN DEFAULT FALSE, -- 根 CA 不在线
    tenant_id       VARCHAR(64), -- 高合规租户独立 CA
    status          VARCHAR(16) DEFAULT 'active', -- active / expired / revoked
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ca_information_type ON ca_information (ca_type);
CREATE INDEX IF NOT EXISTS idx_ca_information_tenant ON ca_information (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ca_information_status ON ca_information (status);

-- ============================================================
-- 3. 统一审计表
-- ============================================================

CREATE TABLE IF NOT EXISTS unified_audit_logs (
    id              VARCHAR(128) PRIMARY KEY,
    event_type      VARCHAR(64) NOT NULL,
    action          VARCHAR(128) NOT NULL,
    resource_type   VARCHAR(64) NOT NULL,
    resource_id     VARCHAR(128) NOT NULL,
    operator_id     VARCHAR(64),
    tenant_id       VARCHAR(64),
    result          VARCHAR(16) NOT NULL, -- success / failed / denied
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    trace_id        VARCHAR(128),
    metadata        JSONB DEFAULT '{}'::jsonb,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 转换为 hypertable（审计日志量大，使用时序存储）
SELECT create_hypertable('unified_audit_logs', 'timestamp', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON unified_audit_logs (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_operator ON unified_audit_logs (operator_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON unified_audit_logs (tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON unified_audit_logs (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_result ON unified_audit_logs (result) WHERE result IN ('failed', 'denied');

-- 审计日志保留 5 年
SELECT add_retention_policy('unified_audit_logs', INTERVAL '1825 days', if_not_exists => TRUE);

-- 审计日志 90 天后压缩
ALTER TABLE unified_audit_logs SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'event_type, tenant_id',
    timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy('unified_audit_logs', INTERVAL '90 days', if_not_exists => TRUE);

-- ============================================================
-- 4. 租户配额表
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_quotas (
    id                      SERIAL PRIMARY KEY,
    tenant_id               VARCHAR(64) NOT NULL UNIQUE,
    plan_name               VARCHAR(32) DEFAULT 'standard', -- free / standard / enterprise
    api_calls_per_minute    INTEGER DEFAULT 1000,
    api_calls_per_hour      INTEGER DEFAULT 30000,
    api_calls_per_day       INTEGER DEFAULT 500000,
    ai_tokens_per_minute    INTEGER DEFAULT 100000,
    ai_tokens_per_day       INTEGER DEFAULT 10000000,
    max_db_connections      INTEGER DEFAULT 20,
    max_concurrent_requests INTEGER DEFAULT 50,
    storage_gb              INTEGER DEFAULT 100,
    max_devices             INTEGER DEFAULT 100,
    max_users               INTEGER DEFAULT 50,
    custom_limits           JSONB DEFAULT '{}'::jsonb,
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_quotas_active ON tenant_quotas (is_active) WHERE is_active = TRUE;

-- ============================================================
-- 5. 租户配额使用记录表
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_quota_usage (
    time            TIMESTAMPTZ NOT NULL,
    tenant_id       VARCHAR(64) NOT NULL,
    metric_type     VARCHAR(32) NOT NULL, -- api_calls / ai_tokens / storage / db_connections
    window          VARCHAR(16) NOT NULL, -- minute / hour / day
    value           BIGINT NOT NULL,
    limit_value     BIGINT,
    is_exceeded     BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (time, tenant_id, metric_type, window)
);

SELECT create_hypertable('tenant_quota_usage', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_quota_usage_tenant ON tenant_quota_usage (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_quota_usage_exceeded ON tenant_quota_usage (is_exceeded) WHERE is_exceeded = TRUE;

-- ============================================================
-- 6. 数据主体请求表
-- ============================================================

CREATE TABLE IF NOT EXISTS data_subject_requests (
    id              SERIAL PRIMARY KEY,
    request_id      VARCHAR(64) NOT NULL UNIQUE,
    user_id         VARCHAR(64) NOT NULL,
    tenant_id       VARCHAR(64),
    request_type    VARCHAR(32) NOT NULL, -- export / delete / access / rectification / withdraw_consent
    status          VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending / processing / completed / failed / cancelled
    data_categories TEXT[] DEFAULT '{"all"}',
    reason          TEXT,
    result          JSONB,
    error           TEXT,
    deadline        TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dsr_user ON data_subject_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dsr_status ON data_subject_requests (status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_dsr_tenant ON data_subject_requests (tenant_id);

-- ============================================================
-- 7. 幂等事件表
-- ============================================================

CREATE TABLE IF NOT EXISTS idempotency_events (
    id              SERIAL PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    device_id       VARCHAR(64) NOT NULL,
    local_sequence  BIGINT NOT NULL,
    event_type      VARCHAR(64) NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'processing', -- processing / completed / failed
    result          JSONB,
    error           TEXT,
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_device_seq ON idempotency_events (device_id, local_sequence);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_events (expires_at) WHERE status = 'processing';

-- ============================================================
-- 8. 密钥访问审计表
-- ============================================================

CREATE TABLE IF NOT EXISTS secret_access_logs (
    id              SERIAL PRIMARY KEY,
    secret_path     VARCHAR(256) NOT NULL,
    operation       VARCHAR(32) NOT NULL, -- read / write / delete / rotate / rollback
    operator_id     VARCHAR(64),
    tenant_id       VARCHAR(64),
    result          VARCHAR(16) NOT NULL, -- success / failed
    details         TEXT,
    trace_id        VARCHAR(128),
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);

SELECT create_hypertable('secret_access_logs', 'timestamp', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_secret_access_path ON secret_access_logs (secret_path, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_secret_access_operator ON secret_access_logs (operator_id, timestamp DESC);

-- 密钥访问日志保留 2 年
SELECT add_retention_policy('secret_access_logs', INTERVAL '730 days', if_not_exists => TRUE);

-- ============================================================
-- 完成
-- ============================================================
