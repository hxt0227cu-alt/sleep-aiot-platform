idf_component_register(
    SRCS "src/light_alarm.c"
    INCLUDE_DIRS "include"
    REQUIRES nvs_flash driver ledc freertos
)
