-- TimescaleDB初始化脚本
-- 创建时序数据表并配置分区和保留策略

-- 启用TimescaleDB扩展
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 将vital_signs_data表转换为时序表
SELECT create_hypertable('vital_signs_data', 'timestamp', if_not_exists => TRUE);

-- 将sleep_state_data表转换为时序表
SELECT create_hypertable('sleep_state_data', 'timestamp', if_not_exists => TRUE);

-- 为vital_signs_data创建分区策略（按天分区）
SELECT add_dimension(
  'vital_signs_data',
  'timestamp',
  interval => '1 day',
  if_not_exists => TRUE
);

-- 为sleep_state_data创建分区策略（按天分区）
SELECT add_dimension(
  'sleep_state_data',
  'timestamp',
  interval => '1 day',
  if_not_exists => TRUE
);

-- 创建数据保留策略（保留90天数据）
SELECT add_retention_policy('vital_signs_data', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('sleep_state_data', INTERVAL '90 days', if_not_exists => TRUE);

-- 创建压缩策略（对7天前的数据进行压缩）
SELECT add_compression_policy('vital_signs_data', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('sleep_state_data', INTERVAL '7 days', if_not_exists => TRUE);

-- 创建聚合视图（1分钟聚合）
CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_1m
WITH (timescaledb.continuous = true) AS
SELECT
  time_bucket('1 minute', timestamp) AS bucket_time,
  device_id,
  AVG(heart_rate) AS avg_heart_rate,
  AVG(breathing_rate) AS avg_breathing_rate,
  AVG(body_movement) AS avg_body_movement,
  MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
  AVG(sleep_score) AS avg_sleep_score
FROM vital_signs_data
GROUP BY bucket_time, device_id;

-- 创建聚合视图（5分钟聚合）
CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_5m
WITH (timescaledb.continuous = true) AS
SELECT
  time_bucket('5 minutes', timestamp) AS bucket_time,
  device_id,
  AVG(heart_rate) AS avg_heart_rate,
  AVG(breathing_rate) AS avg_breathing_rate,
  AVG(body_movement) AS avg_body_movement,
  MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
  AVG(sleep_score) AS avg_sleep_score
FROM vital_signs_data
GROUP BY bucket_time, device_id;

-- 创建聚合视图（1小时聚合）
CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_1h
WITH (timescaledb.continuous = true) AS
SELECT
  time_bucket('1 hour', timestamp) AS bucket_time,
  device_id,
  AVG(heart_rate) AS avg_heart_rate,
  AVG(breathing_rate) AS avg_breathing_rate,
  AVG(body_movement) AS avg_body_movement,
  MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
  AVG(sleep_score) AS avg_sleep_score
FROM vital_signs_data
GROUP BY bucket_time, device_id;

-- 创建索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_vital_signs_device_timestamp ON vital_signs_data(device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sleep_state_device_timestamp ON sleep_state_data(device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vital_signs_1m_device_bucket ON vital_signs_1m(device_id, bucket_time DESC);
CREATE INDEX IF NOT EXISTS idx_vital_signs_5m_device_bucket ON vital_signs_5m(device_id, bucket_time DESC);
CREATE INDEX IF NOT EXISTS idx_vital_signs_1h_device_bucket ON vital_signs_1h(device_id, bucket_time DESC);

-- 创建连续聚合刷新策略（每分钟刷新一次）
SELECT add_continuous_aggregate_policy('vital_signs_1m',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

SELECT add_continuous_aggregate_policy('vital_signs_5m',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

SELECT add_continuous_aggregate_policy('vital_signs_1h',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- 创建函数：获取设备最新状态
CREATE OR REPLACE FUNCTION get_device_latest_status(device_id_param TEXT)
RETURNS TABLE (
  timestamp TIMESTAMP,
  heart_rate INT,
  breathing_rate INT,
  body_movement NUMERIC,
  sleep_state TEXT,
  sleep_score INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    timestamp,
    heart_rate,
    breathing_rate,
    body_movement,
    sleep_state,
    sleep_score
  FROM vital_signs_data
  WHERE device_id = device_id_param
  ORDER BY timestamp DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- 创建函数：获取设备睡眠统计
CREATE OR REPLACE FUNCTION get_device_sleep_stats(device_id_param TEXT, start_time_param TIMESTAMP, end_time_param TIMESTAMP)
RETURNS TABLE (
  avg_heart_rate NUMERIC,
  min_heart_rate INT,
  max_heart_rate INT,
  avg_breathing_rate NUMERIC,
  min_breathing_rate INT,
  max_breathing_rate INT,
  total_records BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    AVG(heart_rate) AS avg_heart_rate,
    MIN(heart_rate) AS min_heart_rate,
    MAX(heart_rate) AS max_heart_rate,
    AVG(breathing_rate) AS avg_breathing_rate,
    MIN(breathing_rate) AS min_breathing_rate,
    MAX(breathing_rate) AS max_breathing_rate,
    COUNT(*) AS total_records
  FROM vital_signs_data
  WHERE device_id = device_id_param
    AND timestamp >= start_time_param
    AND timestamp <= end_time_param;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器：设备状态更新
CREATE OR REPLACE FUNCTION update_device_last_seen()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE devices
  SET last_seen = NEW.timestamp,
      status = 'online'
  WHERE id = NEW.device_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器：当插入新的体征数据时更新设备状态
DROP TRIGGER IF EXISTS trigger_update_device_last_seen ON vital_signs_data;
CREATE TRIGGER trigger_update_device_last_seen
AFTER INSERT ON vital_signs_data
FOR EACH ROW
EXECUTE FUNCTION update_device_last_seen();

-- 创建函数：检测设备离线状态
CREATE OR REPLACE FUNCTION check_offline_devices()
RETURNS VOID AS $$
BEGIN
  UPDATE devices
  SET status = 'offline'
  WHERE last_seen < NOW() - INTERVAL '5 minutes'
    AND status = 'online';
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务：每分钟检查设备离线状态（需要pg_cron扩展）
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('check-offline-devices', '* * * * *', 'SELECT check_offline_devices();');
