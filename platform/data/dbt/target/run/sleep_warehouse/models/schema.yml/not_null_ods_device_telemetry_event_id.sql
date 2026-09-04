
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select event_id
from `ods`.`ods_device_telemetry`
where event_id is null



  
  
    ) dbt_internal_test