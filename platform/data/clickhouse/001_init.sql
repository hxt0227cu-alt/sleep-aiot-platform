CREATE DATABASE IF NOT EXISTS raw;
CREATE DATABASE IF NOT EXISTS ods;
CREATE DATABASE IF NOT EXISTS dwd;
CREATE DATABASE IF NOT EXISTS dws;
CREATE DATABASE IF NOT EXISTS ads;

CREATE TABLE IF NOT EXISTS raw.device_telemetry
(
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
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
  INDEX event_id_bloom event_id TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, device_id, occurred_at, event_id)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY;
