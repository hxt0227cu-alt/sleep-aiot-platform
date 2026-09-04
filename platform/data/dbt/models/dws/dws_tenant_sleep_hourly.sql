{{
  config(
    tags=['telemetry', 'dws'],
    unique_key=['tenant_id', 'hour'],
    incremental_strategy='delete+insert',
    engine='ReplacingMergeTree()',
    order_by='(tenant_id, hour)'
  )
}}

select
  tenant_id,
  toStartOfHour(occurred_at) as hour,
  uniqExact(device_id) as active_devices,
  count() as telemetry_events,
  avgIf(heart_rate, heart_rate is not null) as avg_heart_rate,
  avgIf(breathing_rate, breathing_rate is not null) as avg_breathing_rate,
  quantile(0.95)(ingest_delay_ms) as p95_ingest_delay_ms
from {{ ref('dwd_device_telemetry') }}
{% if is_incremental() %}
where occurred_at >= toStartOfHour(now() - interval 2 hour)
{% endif %}
group by tenant_id, hour
