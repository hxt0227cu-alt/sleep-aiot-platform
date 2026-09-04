select tenant_id, hour, count() as duplicate_rows
from {{ ref('dws_tenant_sleep_hourly') }} final
group by tenant_id, hour
having duplicate_rows > 1
