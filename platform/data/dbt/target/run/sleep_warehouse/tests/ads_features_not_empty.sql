
    
    
    select
      count(*) as failures,
      count(*) != 0 as should_warn,
      count(*) != 0 as should_error
    from (
      
    
  select 1 as missing_features
where (select count() from `ads`.`ads_agent_sleep_features`) = 0
  
  
    ) dbt_internal_test