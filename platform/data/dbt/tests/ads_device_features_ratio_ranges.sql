select tenant_id, device_id
from {{ ref('ads_agent_device_sleep_features') }}
where deep_sleep_ratio not between 0 and 1
   or awake_ratio not between 0 and 1
   or telemetry_events <= 0
   or observed_hours <= 0
