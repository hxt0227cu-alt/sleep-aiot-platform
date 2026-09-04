

  create or replace view `ods`.`ods_device_telemetry` 
  
    
  
  
    
    
  as (
    

select
  event_id, tenant_id, device_id, schema_version, occurred_at, received_at,
  sequence, heart_rate, breathing_rate, body_movement, sleep_state,
  confidence, ingested_at
from `raw`.`device_telemetry`
    
  )
      
      
                    -- end_of_sql
                    
                    