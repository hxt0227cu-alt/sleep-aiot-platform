
        
  
    
    
    
        
         


        
  

  insert into `dwd`.`dwd_device_telemetry__dbt_new_data_e7758e6e_a1c4_47bc_8d3d_afce96d1c498`
        ("event_id", "tenant_id", "device_id", "occurred_at", "received_at", "ingest_delay_ms", "sequence", "heart_rate", "breathing_rate", "body_movement", "sleep_state", "confidence")

select
  event_id,
  tenant_id,
  device_id,
  occurred_at,
  received_at,
  dateDiff('millisecond', occurred_at, received_at) as ingest_delay_ms,
  sequence,
  if(heart_rate between 20 and 240, heart_rate, null) as heart_rate,
  if(breathing_rate between 2 and 80, breathing_rate, null) as breathing_rate,
  greatest(body_movement, 0) as body_movement,
  if(sleep_state in ('awake', 'light', 'deep', 'rem'), sleep_state, 'unknown') as sleep_state,
  least(greatest(confidence, 0), 1) as confidence
from `ods`.`ods_device_telemetry`

where received_at > (select max(received_at) from `dwd`.`dwd_device_telemetry`)

qualify row_number() over (partition by event_id order by received_at asc) = 1
  
      