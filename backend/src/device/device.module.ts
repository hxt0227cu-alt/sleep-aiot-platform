import { Module } from '@nestjs/common';
import { DeviceService } from './device.service';
import { DeviceStatusService } from './device-status.service';
import { DeviceController } from './device.controller';
import { DeviceRegistrationController } from './device-registration.controller';
import { LightAlarmController } from './light-alarm.controller';
import { LightAlarmService } from './light-alarm.service';
import { AuthModule } from '../auth/auth.module';
import { MqttModule } from '../mqtt/mqtt.module';
import { RedisModule } from '../redis/redis.module';
import { DatabaseModule } from '../database/database.module';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [
    AuthModule,
    MqttModule,
    RedisModule,
    DatabaseModule,
    WebSocketModule,
  ],
  controllers: [
    DeviceRegistrationController,
    DeviceController,
    LightAlarmController,
  ],
  providers: [DeviceService, DeviceStatusService, LightAlarmService],
  exports: [DeviceService, DeviceStatusService, LightAlarmService],
})
export class DeviceModule {}
