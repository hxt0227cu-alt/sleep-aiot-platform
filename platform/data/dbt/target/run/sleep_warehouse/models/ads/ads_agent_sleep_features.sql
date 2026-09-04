
  
    
    
    
        
         


        
  

  insert into `ads`.`ads_agent_sleep_features__dbt_backup`
        ("tenant_id", "hour", "active_devices", "telemetry_events", "avg_heart_rate", "avg_breathing_rate", "p95_ingest_delay_ms", "refreshed_at")

select
  tenant_id, hour, active_devices, telemetry_events, avg_heart_rate,
  avg_breathing_rate, p95_ingest_delay_ms, now() as refreshed_at
from `dws`.`dws_tenant_sleep_hourly`
where hour >= now() - interval 30 day
  