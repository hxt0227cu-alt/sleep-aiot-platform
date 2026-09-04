CREATE TABLE IF NOT EXISTS dwd.device_telemetry
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  schema_version UInt16,
  occurred_at DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  sequence UInt64,
  heart_rate Nullable(UInt16),
  breathing_rate Nullable(UInt16),
  body_movement Nullable(Float32),
  sleep_state LowCardinality(String),
  confidence Nullable(Float32),
  processed_at DateTime64(3, 'UTC'),
  INDEX event_id_bloom event_id TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, device_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS dwd.device_telemetry_queue
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  schema_version UInt16,
  occurred_at_ms Int64,
  received_at_ms Int64,
  sequence UInt64,
  heart_rate Nullable(UInt16),
  breathing_rate Nullable(UInt16),
  body_movement Nullable(Float32),
  sleep_state String,
  confidence Nullable(Float32),
  processed_at_ms Int64
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'telemetry.flink.dwd.v1',
  kafka_group_name = 'clickhouse-flink-dwd-v1',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS dwd.device_telemetry_mv
TO dwd.device_telemetry AS
SELECT
  run_id,
  event_id,
  tenant_id,
  device_id,
  schema_version,
  fromUnixTimestamp64Milli(occurred_at_ms) AS occurred_at,
  fromUnixTimestamp64Milli(received_at_ms) AS received_at,
  sequence,
  heart_rate,
  breathing_rate,
  body_movement,
  sleep_state,
  confidence,
  fromUnixTimestamp64Milli(processed_at_ms) AS processed_at
FROM dwd.device_telemetry_queue;

CREATE TABLE IF NOT EXISTS raw.device_telemetry_late
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  occurred_at DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  watermark_at DateTime64(3, 'UTC'),
  lateness_ms UInt64,
  routed_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, device_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS raw.device_telemetry_late_queue
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  occurred_at_ms Int64,
  received_at_ms Int64,
  watermark_ms Int64,
  lateness_ms UInt64,
  routed_at_ms Int64
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'telemetry.flink.late.v1',
  kafka_group_name = 'clickhouse-flink-late-v1',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS raw.device_telemetry_late_mv
TO raw.device_telemetry_late AS
SELECT
  run_id,
  event_id,
  tenant_id,
  device_id,
  fromUnixTimestamp64Milli(occurred_at_ms) AS occurred_at,
  fromUnixTimestamp64Milli(received_at_ms) AS received_at,
  fromUnixTimestamp64Milli(watermark_ms) AS watermark_at,
  lateness_ms,
  fromUnixTimestamp64Milli(routed_at_ms) AS routed_at
FROM raw.device_telemetry_late_queue;

CREATE TABLE IF NOT EXISTS dws.tenant_telemetry_minute
(
  run_id String,
  tenant_id String,
  window_start DateTime64(3, 'UTC'),
  window_end DateTime64(3, 'UTC'),
  telemetry_events UInt64,
  active_devices UInt64,
  avg_heart_rate Nullable(Float64),
  avg_breathing_rate Nullable(Float64),
  emitted_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(emitted_at)
PARTITION BY toYYYYMM(window_start)
ORDER BY (run_id, tenant_id, window_start);

CREATE TABLE IF NOT EXISTS dws.tenant_telemetry_minute_queue
(
  run_id String,
  tenant_id String,
  window_start_ms Int64,
  window_end_ms Int64,
  telemetry_events UInt64,
  active_devices UInt64,
  avg_heart_rate Nullable(Float64),
  avg_breathing_rate Nullable(Float64),
  emitted_at_ms Int64
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'telemetry.flink.aggregate.v1',
  kafka_group_name = 'clickhouse-flink-aggregate-v1',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS dws.tenant_telemetry_minute_mv
TO dws.tenant_telemetry_minute AS
SELECT
  run_id,
  tenant_id,
  fromUnixTimestamp64Milli(window_start_ms) AS window_start,
  fromUnixTimestamp64Milli(window_end_ms) AS window_end,
  telemetry_events,
  active_devices,
  avg_heart_rate,
  avg_breathing_rate,
  fromUnixTimestamp64Milli(emitted_at_ms) AS emitted_at
FROM dws.tenant_telemetry_minute_queue;

CREATE TABLE IF NOT EXISTS raw.flink_invalid_telemetry
(
  run_id String,
  error String,
  payload_bytes UInt32,
  payload_sha256 FixedString(64),
  rejected_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(rejected_at)
ORDER BY (run_id, rejected_at, payload_sha256);

CREATE TABLE IF NOT EXISTS raw.flink_invalid_telemetry_queue
(
  run_id String,
  error String,
  payload_bytes UInt32,
  payload_sha256 String,
  rejected_at_ms Int64
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'telemetry.flink.invalid.v1',
  kafka_group_name = 'clickhouse-flink-invalid-v1',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS raw.flink_invalid_telemetry_mv
TO raw.flink_invalid_telemetry AS
SELECT
  run_id,
  error,
  payload_bytes,
  payload_sha256,
  fromUnixTimestamp64Milli(rejected_at_ms) AS rejected_at
FROM raw.flink_invalid_telemetry_queue;

CREATE TABLE IF NOT EXISTS raw.flink_duplicate_telemetry
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  detected_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(detected_at)
ORDER BY (run_id, tenant_id, device_id, event_id, detected_at);

CREATE TABLE IF NOT EXISTS raw.flink_duplicate_telemetry_queue
(
  run_id String,
  event_id UUID,
  tenant_id String,
  device_id String,
  detected_at_ms Int64
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'telemetry.flink.duplicate.v1',
  kafka_group_name = 'clickhouse-flink-duplicate-v1',
  kafka_format = 'JSONEachRow',
  kafka_num_consumers = 1,
  kafka_thread_per_consumer = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS raw.flink_duplicate_telemetry_mv
TO raw.flink_duplicate_telemetry AS
SELECT
  run_id,
  event_id,
  tenant_id,
  device_id,
  fromUnixTimestamp64Milli(detected_at_ms) AS detected_at
FROM raw.flink_duplicate_telemetry_queue;
