-- ============================================================
-- TimescaleDB 安装与配置验证脚本
-- ============================================================
-- 用途：验证 TimescaleDB 扩展、hypertable、压缩策略、
--       保留策略、连续聚合等配置是否正确生效。
-- 执行：在目标数据库中运行此脚本，检查输出是否符合预期。
-- ============================================================

-- ============================================================
-- 1. 扩展验证
-- ============================================================

\echo '=== 1. 扩展验证 ==='

-- 检查 TimescaleDB 扩展
SELECT extname AS extension, extversion AS version
FROM pg_extension
WHERE extname IN ('timescaledb', 'pgvector');

-- 检查 TimescaleDB 版本
SELECT default_version, installed_version
FROM pg_available_extensions
WHERE name = 'timescaledb';

-- ============================================================
-- 2. Hypertable 验证
-- ============================================================

\echo '=== 2. Hypertable 验证 ==='

-- 列出所有 hypertable
SELECT hypertable_name, hypertable_schema, num_dimensions
FROM timescaledb_information.hypertables
ORDER BY hypertable_name;

-- 检查核心表是否为 hypertable
SELECT
    'device_telemetry' AS table_name,
    EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_telemetry') AS is_hypertable
UNION ALL
SELECT
    'alarm_events',
    EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'alarm_events')
UNION ALL
SELECT
    'sleep_results',
    EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'sleep_results');

-- ============================================================
-- 3. 压缩策略验证
-- ============================================================

\echo '=== 3. 压缩策略验证 ==='

-- 列出压缩策略
SELECT
    hypertable_name,
    config->>'compress_after' AS compress_after,
    schedule_interval,
    next_start,
    proc_schema,
    proc_name
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_compression'
ORDER BY hypertable_name;

-- 检查压缩配置
SELECT
    hypertable_name,
    segmentby_column_index,
    orderby_column_index,
    orderby_asc,
    orderby_nullsfirst
FROM timescaledb_information.compression_settings
ORDER BY hypertable_name, segmentby_column_index;

-- ============================================================
-- 4. 保留策略验证
-- ============================================================

\echo '=== 4. 保留策略验证 ==='

SELECT
    hypertable_name,
    config->>'drop_after' AS drop_after,
    schedule_interval,
    next_start
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_retention'
ORDER BY hypertable_name;

-- ============================================================
-- 5. 连续聚合验证
-- ============================================================

\echo '=== 5. 连续聚合验证 ==='

SELECT
    view_name,
    view_owner,
    materialization_hypertable_name,
    refresh_interval,
    next_start,
    materialized_only
FROM timescaledb_information.continuous_aggregates
ORDER BY view_name;

-- 检查连续聚合刷新策略
SELECT
    cagg.view_name,
    job.config->>'start_offset' AS start_offset,
    job.config->>'end_offset' AS end_offset,
    job.schedule_interval,
    job.next_start
FROM timescaledb_information.jobs job
JOIN timescaledb_information.continuous_aggregates cagg
    ON job.hypertable_name = cagg.materialization_hypertable_name
WHERE job.proc_name = 'policy_refresh_continuous_aggregate';

-- ============================================================
-- 6. 索引验证
-- ============================================================

\echo '=== 6. 索引验证 ==='

SELECT
    tablename AS table_name,
    indexname AS index_name,
    indexdef AS index_definition
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('device_telemetry', 'alarm_events', 'sleep_results')
ORDER BY tablename, indexname;

-- ============================================================
-- 7. 数据量统计
-- ============================================================

\echo '=== 7. 数据量统计 ==='

SELECT
    hypertable_name,
    pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) AS total_size,
    pg_size_pretty(hypertable_detailed_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)->'total_size') AS detailed_size
FROM timescaledb_information.hypertables
ORDER BY hypertable_name;

-- 各表行数（近似值）
SELECT
    relname AS table_name,
    n_live_tup AS approx_row_count,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname IN ('device_telemetry', 'alarm_events', 'sleep_results')
ORDER BY relname;

-- ============================================================
-- 8. 配置参数验证
-- ============================================================

\echo '=== 8. 配置参数验证 ==='

SELECT name, setting, unit, description
FROM pg_settings
WHERE name IN (
    'shared_buffers',
    'effective_cache_size',
    'work_mem',
    'maintenance_work_mem',
    'max_connections',
    'timescaledb.max_background_workers',
    'timescaledb.enable_optimizations'
)
ORDER BY name;

-- ============================================================
-- 9. 验证总结
-- ============================================================

\echo '=== 9. 验证总结 ==='

SELECT
    '扩展' AS check_item,
    CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status,
    COUNT(*) || ' 个扩展已安装' AS detail
FROM pg_extension WHERE extname = 'timescaledb'

UNION ALL

SELECT
    'Hypertable',
    CASE WHEN COUNT(*) >= 3 THEN 'PASS' ELSE 'FAIL' END,
    COUNT(*) || ' 个 hypertable 已创建'
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('device_telemetry', 'alarm_events', 'sleep_results')

UNION ALL

SELECT
    '压缩策略',
    CASE WHEN COUNT(*) >= 2 THEN 'PASS' ELSE 'FAIL' END,
    COUNT(*) || ' 个压缩策略已配置'
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_compression'

UNION ALL

SELECT
    '保留策略',
    CASE WHEN COUNT(*) >= 2 THEN 'PASS' ELSE 'FAIL' END,
    COUNT(*) || ' 个保留策略已配置'
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_retention'

UNION ALL

SELECT
    '连续聚合',
    CASE WHEN COUNT(*) >= 2 THEN 'PASS' ELSE 'FAIL' END,
    COUNT(*) || ' 个连续聚合已创建'
FROM timescaledb_information.continuous_aggregates;

-- ============================================================
-- 验证完成
-- ============================================================
