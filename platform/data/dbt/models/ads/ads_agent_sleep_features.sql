{{ config(tags=['telemetry', 'ads'], engine='MergeTree()', order_by='(tenant_id, hour)') }}

select
  tenant_id, hour, active_devices, telemetry_events, avg_heart_rate,
  avg_breathing_rate, p95_ingest_delay_ms, now() as refreshed_at
from {{ ref('dws_tenant_sleep_hourly') }}
where hour >= now() - interval 30 day
