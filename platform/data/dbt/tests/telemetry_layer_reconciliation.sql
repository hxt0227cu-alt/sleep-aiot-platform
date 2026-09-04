select
  (select count() from {{ ref('dwd_device_telemetry') }} final) as dwd_rows,
  (select uniqExact(event_id) from {{ ref('ods_device_telemetry') }}) as ods_unique_events
where dwd_rows != ods_unique_events
