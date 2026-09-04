select
  (select count() from `dwd`.`dwd_device_telemetry` final) as dwd_rows,
  (select uniqExact(event_id) from `ods`.`ods_device_telemetry`) as ods_unique_events
where dwd_rows != ods_unique_events