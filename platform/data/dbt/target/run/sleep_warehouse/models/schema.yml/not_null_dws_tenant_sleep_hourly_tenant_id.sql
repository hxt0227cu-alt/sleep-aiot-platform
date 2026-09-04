
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select tenant_id
from `dws`.`dws_tenant_sleep_hourly`
where tenant_id is null



  
  
    ) dbt_internal_test