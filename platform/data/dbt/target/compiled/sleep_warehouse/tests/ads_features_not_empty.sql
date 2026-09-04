select 1 as missing_features
where (select count() from `ads`.`ads_agent_sleep_features`) = 0