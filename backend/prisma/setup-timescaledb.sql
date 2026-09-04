\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- The optional psql variable is a test/deployment override. Production defaults
-- to the capability exposed by the server's TimescaleDB license.
\if :{?timescale_capability_mode}
SELECT set_config(
  'sleep.timescale_capability_mode',
  :'timescale_capability_mode',
  false
);
\endif

DO $timescale_mode_validation$
BEGIN
  IF current_setting('sleep.timescale_capability_mode', true) IS NOT NULL
     AND current_setting('sleep.timescale_capability_mode')
       NOT IN ('auto', 'full', 'apache-core') THEN
    RAISE EXCEPTION 'Unsupported TimescaleDB capability mode: %',
      current_setting('sleep.timescale_capability_mode');
  END IF;
END
$timescale_mode_validation$;

SELECT CASE
    WHEN current_setting('sleep.timescale_capability_mode', true)
      IN ('full', 'apache-core')
      THEN current_setting('sleep.timescale_capability_mode')
    WHEN lower(coalesce(current_setting('timescaledb.license', true), '')) = 'apache'
      THEN 'apache-core'
    ELSE 'full'
  END AS timescale_effective_mode,
  CASE
    WHEN current_setting('sleep.timescale_capability_mode', true) = 'apache-core'
      THEN false
    WHEN current_setting('sleep.timescale_capability_mode', true) = 'full'
      THEN true
    ELSE lower(coalesce(current_setting('timescaledb.license', true), '')) <> 'apache'
  END AS timescale_full
\gset

SELECT set_config('sleep.timescale_effective_mode', :'timescale_effective_mode', false);

SELECT create_hypertable(
  'vital_signs_data',
  'timestamp',
  if_not_exists => TRUE,
  migrate_data => TRUE
);

SELECT create_hypertable(
  'sleep_state_data',
  'timestamp',
  if_not_exists => TRUE,
  migrate_data => TRUE
);

CREATE INDEX IF NOT EXISTS idx_vital_signs_device_time
  ON vital_signs_data(device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sleep_state_device_time
  ON sleep_state_data(device_id, timestamp DESC);

\if :timescale_full
SELECT add_retention_policy('vital_signs_data', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('sleep_state_data', INTERVAL '90 days', if_not_exists => TRUE);

ALTER TABLE vital_signs_data SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id'
);
ALTER TABLE sleep_state_data SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id'
);
SELECT add_compression_policy('vital_signs_data', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('sleep_state_data', INTERVAL '7 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', timestamp) AS bucket,
       device_id,
       AVG(heart_rate) AS avg_heart_rate,
       AVG(breathing_rate) AS avg_breathing_rate,
       AVG(body_movement) AS avg_body_movement,
       MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
       COUNT(*) AS count
FROM vital_signs_data
GROUP BY bucket, device_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_5m
WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', timestamp) AS bucket,
       device_id,
       AVG(heart_rate) AS avg_heart_rate,
       AVG(breathing_rate) AS avg_breathing_rate,
       AVG(body_movement) AS avg_body_movement,
       MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
       COUNT(*) AS count
FROM vital_signs_data
GROUP BY bucket, device_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS vital_signs_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', timestamp) AS bucket,
       device_id,
       AVG(heart_rate) AS avg_heart_rate,
       AVG(breathing_rate) AS avg_breathing_rate,
       AVG(body_movement) AS avg_body_movement,
       MODE() WITHIN GROUP (ORDER BY sleep_state) AS mode_sleep_state,
       COUNT(*) AS count
FROM vital_signs_data
GROUP BY bucket, device_id;

SELECT add_retention_policy('vital_signs_1m', INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('vital_signs_5m', INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('vital_signs_1h', INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy(
  'vital_signs_1m',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'vital_signs_5m',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);
SELECT add_continuous_aggregate_policy(
  'vital_signs_1h',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
\else
\echo 'TimescaleDB capability mode apache-core: policy and continuous aggregate DDL skipped'
\endif
