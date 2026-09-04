select event_id
from `dwd`.`dwd_device_telemetry`
where (heart_rate is not null and heart_rate not between 20 and 240)
   or (breathing_rate is not null and breathing_rate not between 2 and 80)
   or (body_movement is not null and body_movement < 0)
   or (confidence is not null and confidence not between 0 and 1)
   or sleep_state not in ('awake', 'light', 'deep', 'rem', 'unknown')