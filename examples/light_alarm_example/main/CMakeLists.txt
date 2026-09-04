idf_component_register(
    SRCS "light_alarm_example.c"
    INCLUDE_DIRS "."
    REQUIRES light_alarm esp_wifi esp_netif esp_sntp
)
