
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select ingest_delay_ms
from `dwd`.`dwd_device_telemetry`
where ingest_delay_ms is null



  
  
    ) dbt_internal_test