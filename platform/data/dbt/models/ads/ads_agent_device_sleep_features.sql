{{ config(tags=['telemetry', 'ads', 'agent-feature'], engine='MergeTree()', order_by='(tenant_id, device_id)') }}

select
  tenant_id,
  device_id,
  7 as window_days,
  now() - interval 7 day as window_start,
  now() as window_end,
  count() as telemetry_events,
  uniqExact(toStartOfHour(occurred_at)) as observed_hours,
  avgIf(heart_rate, heart_rate is not null) as avg_heart_rate,
  avgIf(breathing_rate, breathing_rate is not null) as avg_breathing_rate,
  sum(body_movement) as total_body_movement,
  countIf(sleep_state = 'deep') / count() as deep_sleep_ratio,
  countIf(sleep_state = 'awake') / count() as awake_ratio,
  quantile(0.95)(ingest_delay_ms) as p95_ingest_delay_ms,
  max(occurred_at) as source_max_occurred_at,
  now() as refreshed_at
from {{ ref('dwd_device_telemetry') }} final
where occurred_at >= now() - interval 7 day
group by tenant_id, device_id
