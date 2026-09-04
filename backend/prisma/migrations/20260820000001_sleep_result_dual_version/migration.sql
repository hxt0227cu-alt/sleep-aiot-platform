-- ============================================================
-- 睡眠结果双版本迁移
-- ============================================================
-- 功能：
--   1. 为 sleep_results 表添加结果来源、算法版本、固件版本字段
--   2. 添加差异记录字段（云端与边缘结果对比）
--   3. 创建双版本存储的索引和视图
--   4. 支持边缘临时期结果与云端最终结果共存
-- ============================================================

-- ============================================================
-- 1. 添加新字段（如果不存在）
-- ============================================================

-- 结果来源：edge_preliminary（边缘临时期）/ cloud_final（云端最终）
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS result_source VARCHAR(16) DEFAULT 'cloud_final';

-- 算法版本号
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS algorithm_version VARCHAR(32);

-- 固件版本号
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);

-- 本地序列号（用于幂等和数据追溯）
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS local_sequence BIGINT;

-- 与边缘结果的差异记录（JSONB）
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS diff_from_edge JSONB;

-- 差异状态：match / minor_diff / major_diff / no_edge_result
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS diff_status VARCHAR(20) DEFAULT 'no_edge_result';

-- 报告生成时间
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NOW();

-- 报告生成来源模块
ALTER TABLE sleep_results ADD COLUMN IF NOT EXISTS generated_by VARCHAR(32) DEFAULT 'cloud';

-- ============================================================
-- 2. 更新主键（包含 result_source 以支持双版本）
-- ============================================================

-- 注意：如果表已经是 hypertable，修改主键需要特殊处理
-- 这里假设 sleep_results 表已存在且主键为 (time, device_id)
-- 实际迁移时需要根据现有表结构调整

-- ============================================================
-- 3. 创建双版本相关索引
-- ============================================================

-- 按结果来源查询
CREATE INDEX IF NOT EXISTS idx_sleep_results_source ON sleep_results (result_source, time DESC);

-- 按算法版本查询（用于算法升级对比）
CREATE INDEX IF NOT EXISTS idx_sleep_results_algorithm ON sleep_results (algorithm_version);

-- 按差异状态查询（用于质量监控）
CREATE INDEX IF NOT EXISTS idx_sleep_results_diff_status ON sleep_results (diff_status) WHERE diff_status != 'match';

-- 设备 + 日期 + 来源的复合索引（快速查询某设备某天的双版本结果）
CREATE INDEX IF NOT EXISTS idx_sleep_results_device_date_source
ON sleep_results (device_id, time DESC, result_source);

-- ============================================================
-- 4. 创建双版本对比视图
-- ============================================================

-- 设备每日睡眠结果双版本对比视图
CREATE OR REPLACE VIEW v_sleep_results_comparison AS
SELECT
    DATE(sr.time) AS report_date,
    sr.device_id,
    sr.tenant_id,
    -- 云端最终结果
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.sleep_score END) AS cloud_sleep_score,
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.sleep_duration_seconds END) AS cloud_sleep_duration,
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.algorithm_version END) AS cloud_algorithm_version,
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.firmware_version END) AS cloud_firmware_version,
    -- 边缘临时期结果
    MAX(CASE WHEN sr.result_source = 'edge_preliminary' THEN sr.sleep_score END) AS edge_sleep_score,
    MAX(CASE WHEN sr.result_source = 'edge_preliminary' THEN sr.sleep_duration_seconds END) AS edge_sleep_duration,
    MAX(CASE WHEN sr.result_source = 'edge_preliminary' THEN sr.algorithm_version END) AS edge_algorithm_version,
    MAX(CASE WHEN sr.result_source = 'edge_preliminary' THEN sr.firmware_version END) AS edge_firmware_version,
    -- 差异
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.diff_status END) AS diff_status,
    MAX(CASE WHEN sr.result_source = 'cloud_final' THEN sr.diff_from_edge END) AS diff_details,
    -- 统计
    COUNT(*) FILTER (WHERE sr.result_source = 'cloud_final') AS has_cloud_result,
    COUNT(*) FILTER (WHERE sr.result_source = 'edge_preliminary') AS has_edge_result
FROM sleep_results sr
GROUP BY DATE(sr.time), sr.device_id, sr.tenant_id
ORDER BY report_date DESC, sr.device_id;

-- ============================================================
-- 5. 创建算法版本对比视图
-- ============================================================

-- 不同算法版本的睡眠结果对比（用于算法升级评估）
CREATE OR REPLACE VIEW v_algorithm_version_comparison AS
SELECT
    algorithm_version,
    firmware_version,
    COUNT(*) AS report_count,
    AVG(sleep_score)::INTEGER AS avg_sleep_score,
    AVG(sleep_duration_seconds)::INTEGER AS avg_sleep_duration,
    AVG(sleep_efficiency) AS avg_sleep_efficiency,
    AVG(deep_sleep_seconds)::INTEGER AS avg_deep_sleep,
    AVG(rem_sleep_seconds)::INTEGER AS avg_rem_sleep,
    AVG(awake_seconds)::INTEGER AS avg_awake,
    MIN(time) AS first_report,
    MAX(time) AS last_report,
    COUNT(DISTINCT device_id) AS device_count
FROM sleep_results
WHERE result_source = 'cloud_final'
  AND algorithm_version IS NOT NULL
GROUP BY algorithm_version, firmware_version
ORDER BY algorithm_version DESC, firmware_version DESC;

-- ============================================================
-- 6. 创建差异统计视图
-- ============================================================

-- 边缘与云端结果差异统计（用于质量监控和算法优化）
CREATE OR REPLACE VIEW v_edge_cloud_diff_stats AS
SELECT
    DATE(time) AS report_date,
    tenant_id,
    diff_status,
    COUNT(*) AS count,
    -- 睡眠评分差异统计
    AVG(CASE
        WHEN diff_from_edge ? 'sleep_score_diff'
        THEN ABS((diff_from_edge->>'sleep_score_diff')::INTEGER)
    END) AS avg_sleep_score_diff,
    MAX(CASE
        WHEN diff_from_edge ? 'sleep_score_diff'
        THEN ABS((diff_from_edge->>'sleep_score_diff')::INTEGER)
    END) AS max_sleep_score_diff,
    -- 睡眠时长差异统计
    AVG(CASE
        WHEN diff_from_edge ? 'sleep_duration_diff'
        THEN ABS((diff_from_edge->>'sleep_duration_diff')::INTEGER)
    END) AS avg_duration_diff_seconds
FROM sleep_results
WHERE result_source = 'cloud_final'
  AND diff_status != 'no_edge_result'
GROUP BY DATE(time), tenant_id, diff_status
ORDER BY report_date DESC, tenant_id, diff_status;

-- ============================================================
-- 7. 数据迁移：为现有数据填充默认值
-- ============================================================

-- 为现有记录设置默认结果来源
UPDATE sleep_results
SET result_source = 'cloud_final'
WHERE result_source IS NULL;

-- 为现有记录设置默认差异状态
UPDATE sleep_results
SET diff_status = 'no_edge_result'
WHERE diff_status IS NULL;

-- ============================================================
-- 完成
-- ============================================================
