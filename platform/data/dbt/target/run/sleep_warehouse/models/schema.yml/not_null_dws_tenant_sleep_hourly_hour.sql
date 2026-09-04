
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select hour
from `dws`.`dws_tenant_sleep_hourly`
where hour is null



  
  
    ) dbt_internal_test