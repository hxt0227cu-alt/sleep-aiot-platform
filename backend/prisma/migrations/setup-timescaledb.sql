-- ============================================================
-- TimescaleDB 表结构与索引设置脚本
-- ============================================================
-- 功能：
--   1. 创建 hypertable（时序表）
--   2. 设置数据生命周期分区
--   3. 配置冷热数据分级规则
--   4. 创建连续聚合视图
--   5. 设置保留策略
-- ============================================================

-- 启用 TimescaleDB 扩展（如果尚未启用）
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgvector;

-- ============================================================
-- 1. 遥测数据表（核心时序表）
-- ============================================================

-- 设备遥测原始数据表
CREATE TABLE IF NOT EXISTS device_telemetry (
    time        TIMESTAMPTZ       NOT NULL,
    device_id   VARCHAR(64)       NOT NULL,
    tenant_id   VARCHAR(64)       NOT NULL,
    heart_rate  INTEGER,
    respiration INTEGER,
    movement    INTEGER,
    sleep_state SMALLINT,
    bed_presence BOOLEAN,
    temperature DOUBLE PRECISION,
    humidity    DOUBLE PRECISION,
    local_sequence BIGINT,
    firmware_version VARCHAR(32),
    rssi        INTEGER,
    metadata    JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (time, device_id)
);

-- 转换为 hypertable
SELECT create_hypertable('device_telemetry', 'time', if_not_exists => TRUE);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_device_telemetry_device_time ON device_telemetry (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_device_telemetry_tenant_time ON device_telemetry (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_device_telemetry_sleep_state ON device_telemetry (sleep_state) WHERE sleep_state IS NOT NULL;

-- ============================================================
-- 2. 报警事件表
-- ============================================================

CREATE TABLE IF NOT EXISTS alarm_events (
    time        TIMESTAMPTZ       NOT NULL,
    device_id   VARCHAR(64)       NOT NULL,
    tenant_id   VARCHAR(64)       NOT NULL,
    alarm_type  VARCHAR(32)       NOT NULL,
    alarm_level VARCHAR(16)       NOT NULL,
    source      VARCHAR(16)       NOT NULL DEFAULT 'edge',  -- edge / cloud
    value       DOUBLE PRECISION,
    threshold   DOUBLE PRECISION,
    duration_seconds INTEGER,
    status      VARCHAR(16)       NOT NULL DEFAULT 'pending', -- pending / handled / false_positive
    handled_by  VARCHAR(64),
    handled_at  TIMESTAMPTZ,
    note        TEXT,
    metadata    JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (time, device_id, alarm_type)
);

SELECT create_hypertable('alarm_events', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_alarm_events_device_time ON alarm_events (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_events_status ON alarm_events (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_alarm_events_tenant_time ON alarm_events (tenant_id, time DESC);

-- ============================================================
-- 3. 睡眠结果表（双版本：边缘 + 云端）
-- ============================================================

CREATE TABLE IF NOT EXISTS sleep_results (
    time        TIMESTAMPTZ       NOT NULL,
    device_id   VARCHAR(64)       NOT NULL,
    tenant_id   VARCHAR(64)       NOT NULL,
    result_source VARCHAR(16)     NOT NULL, -- edge_preliminary / cloud_final
    algorithm_version VARCHAR(32) NOT NULL,
    firmware_version VARCHAR(32),
    sleep_score INTEGER,
    sleep_duration_seconds INTEGER,
    deep_sleep_seconds INTEGER,
    light_sleep_seconds INTEGER,
    rem_sleep_seconds INTEGER,
    awake_seconds INTEGER,
    sleep_efficiency DOUBLE PRECISION,
    avg_heart_rate INTEGER,
    avg_respiration INTEGER,
    movement_count INTEGER,
    bed_exit_count INTEGER,
    is_final    BOOLEAN DEFAULT FALSE,
    diff_from_edge JSONB,  -- 云端结果与边缘结果的差异记录
    metadata    JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (time, device_id, result_source)
);

SELECT create_hypertable('sleep_results', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sleep_results_device_time ON sleep_results (device_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_sleep_results_final ON sleep_results (device_id, time DESC) WHERE is_final = TRUE;
CREATE INDEX IF NOT EXISTS idx_sleep_results_algorithm ON sleep_results (algorithm_version);

-- ============================================================
-- 4. 连续聚合视图
-- ============================================================

-- 设备遥测小时级聚合
CREATE MATERIALIZED VIEW IF NOT EXISTS device_telemetry_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    device_id,
    tenant_id,
    AVG(heart_rate)::INTEGER AS avg_heart_rate,
    MIN(heart_rate) AS min_heart_rate,
    MAX(heart_rate) AS max_heart_rate,
    AVG(respiration)::INTEGER AS avg_respiration,
    AVG(movement)::INTEGER AS avg_movement,
    COUNT(*) AS sample_count,
    MODE() WITHIN GROUP (ORDER BY sleep_state) AS dominant_sleep_state
FROM device_telemetry
GROUP BY bucket, device_id, tenant_id
WITH NO DATA;

-- 启用实时聚合
ALTER MATERIALIZED VIEW device_telemetry_hourly SET (timescaledb.materialized_only = false);

-- 睡眠结果日级聚合
CREATE MATERIALIZED VIEW IF NOT EXISTS sleep_results_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time) AS bucket,
    device_id,
    tenant_id,
    AVG(sleep_score)::INTEGER AS avg_sleep_score,
    AVG(sleep_duration_seconds)::INTEGER AS avg_sleep_duration,
    AVG(sleep_efficiency) AS avg_sleep_efficiency,
    COUNT(*) AS report_count
FROM sleep_results
WHERE is_final = TRUE
GROUP BY bucket, device_id, tenant_id
WITH NO DATA;

-- ============================================================
-- 5. 数据保留策略（冷热数据分级）
-- ============================================================

-- 原始遥测数据保留 90 天
SELECT add_retention_policy('device_telemetry', INTERVAL '90 days', if_not_exists => TRUE);

-- 报警事件保留 1 年
SELECT add_retention_policy('alarm_events', INTERVAL '365 days', if_not_exists => TRUE);

-- 睡眠结果永久保留（不设置保留策略）

-- 小时级聚合保留 2 年
SELECT add_retention_policy('device_telemetry_hourly', INTERVAL '730 days', if_not_exists => TRUE);

-- ============================================================
-- 6. 压缩策略（冷热数据分级）
-- ============================================================

-- 启用压缩
ALTER TABLE device_telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, tenant_id',
    timescaledb.compress_orderby = 'time DESC'
);

-- 7 天前的数据自动压缩
SELECT add_compression_policy('device_telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- 报警事件 30 天后压缩
ALTER TABLE alarm_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, alarm_type',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('alarm_events', INTERVAL '30 days', if_not_exists => TRUE);

-- ============================================================
-- 7. 数据生命周期管理表
-- ============================================================

CREATE TABLE IF NOT EXISTS data_lifecycle_config (
    id          SERIAL PRIMARY KEY,
    data_type   VARCHAR(64) NOT NULL UNIQUE,
    retention_days INTEGER NOT NULL,
    archive_after_days INTEGER,
    compress_after_days INTEGER,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 初始化生命周期配置
INSERT INTO data_lifecycle_config (data_type, retention_days, archive_after_days, compress_after_days, description)
VALUES
    ('device_telemetry', 90, 30, 7, '设备遥测原始数据'),
    ('alarm_events', 365, 90, 30, '报警事件数据'),
    ('sleep_results', -1, NULL, NULL, '睡眠结果数据（永久保留）'),
    ('audit_logs', 1825, 365, 90, '审计日志（5年）'),
    ('voice_data', 90, 30, 7, '语音数据')
ON CONFLICT (data_type) DO NOTHING;

-- ============================================================
-- 完成
-- ============================================================
