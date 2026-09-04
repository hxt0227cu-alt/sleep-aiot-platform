select tenant_id, device_id, count() as duplicate_rows
from {{ ref('ads_agent_device_sleep_features') }}
group by tenant_id, device_id
having duplicate_rows > 1
