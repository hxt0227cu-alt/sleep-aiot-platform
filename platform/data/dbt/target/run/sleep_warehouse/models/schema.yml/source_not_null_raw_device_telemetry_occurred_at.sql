
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select occurred_at
from `raw`.`device_telemetry`
where occurred_at is null



  
  
    ) dbt_internal_test