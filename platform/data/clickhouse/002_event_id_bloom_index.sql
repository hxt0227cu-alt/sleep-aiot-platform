ALTER TABLE raw.device_telemetry
  ADD INDEX IF NOT EXISTS event_id_bloom event_id
  TYPE bloom_filter(0.001) GRANULARITY 1;
