
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  
    
    



select refreshed_at
from `ads`.`ads_agent_sleep_features`
where refreshed_at is null



  
  
    ) dbt_internal_test