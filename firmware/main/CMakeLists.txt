idf_component_register(SRCS "main.cpp"
                       "wifi_manager.cpp"
                       "mqtt_client.cpp"
                       "led_driver.cpp"
                       "radar_driver.cpp"
                       "audio_driver.cpp"
                       "data_report.cpp"
                       "light_control.cpp"
                       "alarm_service.cpp"
                       "ota_service.cpp"
                       "microphone_driver.cpp"
                       "potentiometer_driver.cpp"
                       "white_noise_player.cpp"
                       "touch_control.cpp"
                       "local_voice_command.cpp"
                       "provisioning_service.cpp"
                       "anion_driver.cpp"
                       "app_sleep.cpp"
                       "gsm_driver.cpp"
                       INCLUDE_DIRS "." "include"
                       REQUIRES driver app_update bt esp_http_server nvs_flash esp_wifi esp_netif
                                esp_event esp_timer spi_flash esp_psram esp_driver_gpio
                                esp_driver_uart esp_driver_i2s esp_adc mqtt esp_http_client
                                esp_https_ota esp_partition spiffs espressif__cjson espressif__esp-sr)

spiffs_create_partition_image(storage ../storage FLASH_IN_PROJECT)
