select 1 as missing_device_features
where (select count() from {{ ref('ads_agent_device_sleep_features') }}) = 0
