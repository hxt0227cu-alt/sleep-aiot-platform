
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  select tenant_id, hour, count() as duplicate_rows
from `dws`.`dws_tenant_sleep_hourly` final
group by tenant_id, hour
having duplicate_rows > 1
  
  
    ) dbt_internal_test