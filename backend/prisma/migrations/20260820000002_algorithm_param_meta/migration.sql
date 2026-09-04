-- ============================================================
-- 算法参数包元数据迁移
-- ============================================================
-- 功能：
--   1. 创建算法参数包元数据表
--   2. 记录参数版本、固件兼容范围、签名、生效时间等
--   3. 支持参数包灰度发布与回滚
--   4. 创建设备参数同步状态表
-- ============================================================

-- ============================================================
-- 1. 算法参数包元数据表
-- ============================================================

CREATE TABLE IF NOT EXISTS algorithm_param_packages (
    id                  SERIAL PRIMARY KEY,
    package_id          VARCHAR(128) NOT NULL UNIQUE,
    schema_version      VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    algorithm_type      VARCHAR(64) NOT NULL, -- sleep_stage / alarm_detection / radar_calibration
    param_version       VARCHAR(32) NOT NULL,
    name                VARCHAR(256) NOT NULL,
    description         TEXT,
    author              VARCHAR(64) NOT NULL DEFAULT 'system',

    -- 固件兼容性
    min_firmware_version VARCHAR(32) NOT NULL,
    max_firmware_version VARCHAR(32),
    supported_models    TEXT[] DEFAULT '{}',

    -- 参数内容
    parameters          JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- 签名信息
    signature_algorithm VARCHAR(32) NOT NULL DEFAULT 'ECDSA-SHA256',
    signature_value     TEXT NOT NULL,
    signer              VARCHAR(64) NOT NULL DEFAULT 'system',
    signed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 生命周期
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    rollback_version    VARCHAR(32), -- 回滚目标版本
    status              VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft / testing / active / deprecated / rolled_back

    -- 灰度发布
    rollout_percentage  INTEGER DEFAULT 0, -- 0-100
    rollout_strategy    VARCHAR(32) DEFAULT 'canary', -- canary / percentage / device_group
    device_group        VARCHAR(64),

    -- 变更记录
    changelog           TEXT[] DEFAULT '{}',
    previous_package_id VARCHAR(128),

    -- 元数据
    metadata            JSONB DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    -- 约束
    CONSTRAINT chk_rollout_percentage CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
    CONSTRAINT chk_status CHECK (status IN ('draft', 'testing', 'active', 'deprecated', 'rolled_back'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_param_packages_algorithm ON algorithm_param_packages (algorithm_type, param_version DESC);
CREATE INDEX IF NOT EXISTS idx_param_packages_status ON algorithm_param_packages (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_param_packages_rollout ON algorithm_param_packages (rollout_percentage) WHERE rollout_percentage > 0;
CREATE INDEX IF NOT EXISTS idx_param_packages_effective ON algorithm_param_packages (effective_from, expires_at);
CREATE INDEX IF NOT EXISTS idx_param_packages_firmware ON algorithm_param_packages (min_firmware_version, max_firmware_version);

-- ============================================================
-- 2. 设备参数同步状态表
-- ============================================================

CREATE TABLE IF NOT EXISTS device_param_sync_status (
    id                  SERIAL PRIMARY KEY,
    device_id           VARCHAR(64) NOT NULL,
    tenant_id           VARCHAR(64),
    package_id          VARCHAR(128) NOT NULL,
    algorithm_type      VARCHAR(64) NOT NULL,
    current_version     VARCHAR(32),
    target_version      VARCHAR(32) NOT NULL,

    -- 同步状态
    sync_status         VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending / downloading / applied / verified / failed / rolled_back
    sync_attempts       INTEGER DEFAULT 0,
    last_attempt_at     TIMESTAMPTZ,
    last_error          TEXT,

    -- 验证结果
    verified_at         TIMESTAMPTZ,
    verification_result VARCHAR(16), -- success / failed / partial
    verification_details JSONB,

    -- 时间戳
    applied_at          TIMESTAMPTZ,
    rolled_back_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    -- 约束
    CONSTRAINT chk_sync_status CHECK (sync_status IN ('pending', 'downloading', 'applied', 'verified', 'failed', 'rolled_back')),
    UNIQUE (device_id, package_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_param_sync_device ON device_param_sync_status (device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_param_sync_status ON device_param_sync_status (sync_status) WHERE sync_status IN ('pending', 'downloading', 'failed');
CREATE INDEX IF NOT EXISTS idx_param_sync_package ON device_param_sync_status (package_id);
CREATE INDEX IF NOT EXISTS idx_param_sync_tenant ON device_param_sync_status (tenant_id);

-- ============================================================
-- 3. 参数包审批记录表
-- ============================================================

CREATE TABLE IF NOT EXISTS algorithm_param_approvals (
    id                  SERIAL PRIMARY KEY,
    package_id          VARCHAR(128) NOT NULL,
    approval_type       VARCHAR(32) NOT NULL, -- create / update / rollout / rollback / deprecate
    status              VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending / approved / rejected / cancelled
    requester           VARCHAR(64) NOT NULL,
    approver            VARCHAR(64),
    reason              TEXT,
    rejection_reason    TEXT,
    requested_at        TIMESTAMPTZ DEFAULT NOW(),
    approved_at         TIMESTAMPTZ,
    metadata            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_param_approvals_package ON algorithm_param_approvals (package_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_param_approvals_status ON algorithm_param_approvals (status) WHERE status = 'pending';

-- ============================================================
-- 4. 参数包灰度发布事件表
-- ============================================================

CREATE TABLE IF NOT EXISTS param_rollout_events (
    id                  SERIAL PRIMARY KEY,
    package_id          VARCHAR(128) NOT NULL,
    event_type          VARCHAR(32) NOT NULL, -- rollout_start / rollout_progress / rollout_complete / rollback_start / rollback_complete
    from_percentage     INTEGER,
    to_percentage       INTEGER,
    device_count        INTEGER,
    success_count       INTEGER,
    failed_count        INTEGER,
    operator            VARCHAR(64),
    metadata            JSONB DEFAULT '{}'::jsonb,
    timestamp           TIMESTAMPTZ DEFAULT NOW()
);

SELECT create_hypertable('param_rollout_events', 'timestamp', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_rollout_events_package ON param_rollout_events (package_id, timestamp DESC);

-- ============================================================
-- 5. 算法提案与参数包关联表
-- ============================================================

CREATE TABLE IF NOT EXISTS algorithm_proposal_param_links (
    id                  SERIAL PRIMARY KEY,
    proposal_id         VARCHAR(64) NOT NULL,
    package_id          VARCHAR(128) NOT NULL,
    link_type           VARCHAR(32) NOT NULL, -- generated_from / applied_to / rollback_target
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (proposal_id, package_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_proposal_param_links_proposal ON algorithm_proposal_param_links (proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_param_links_package ON algorithm_proposal_param_links (package_id);

-- ============================================================
-- 6. 初始化默认参数包
-- ============================================================

-- 插入默认睡眠分期算法参数包（v1.0.0）
INSERT INTO algorithm_param_packages (
    package_id, algorithm_type, param_version, name, description,
    min_firmware_version, parameters, signature_value, status, effective_from
) VALUES (
    'param-sleep-stage-1.0.0-default',
    'sleep_stage',
    '1.0.0',
    '默认睡眠分期参数包 v1.0.0',
    '生产环境默认睡眠分期算法参数，适用于大多数场景',
    '1.0.0',
    '{"heart_rate_weight": 0.3, "respiration_weight": 0.3, "movement_weight": 0.4, "deep_sleep_threshold": 0.7, "rem_threshold": 0.5, "awake_threshold": 0.3, "smoothing_window_seconds": 120, "minimum_sleep_minutes": 20}'::jsonb,
    'default-signature-placeholder',
    'active',
    NOW()
) ON CONFLICT (package_id) DO NOTHING;

-- 插入默认报警检测参数包
INSERT INTO algorithm_param_packages (
    package_id, algorithm_type, param_version, name, description,
    min_firmware_version, parameters, signature_value, status, effective_from
) VALUES (
    'param-alarm-detection-1.0.0-default',
    'alarm_detection',
    '1.0.0',
    '默认报警检测参数包 v1.0.0',
    '生产环境默认报警检测阈值参数',
    '1.0.0',
    '{"heart_rate_low": 40, "heart_rate_high": 120, "respiration_low": 8, "respiration_high": 30, "bed_exit_timeout_seconds": 180, "movement_high": 50, "duration_threshold_seconds": 30, "cooldown_seconds": 300}'::jsonb,
    'default-signature-placeholder',
    'active',
    NOW()
) ON CONFLICT (package_id) DO NOTHING;

-- ============================================================
-- 完成
-- ============================================================
