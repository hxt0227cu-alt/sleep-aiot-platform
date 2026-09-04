{{ config(tags=['telemetry', 'ods']) }}

select
  event_id, tenant_id, device_id, schema_version, occurred_at, received_at,
  sequence, heart_rate, breathing_rate, body_movement, sleep_state,
  confidence, ingested_at
from {{ source('raw', 'device_telemetry') }}
