import { Module, Global } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { MqttRouterService } from './mqtt-router.service';
import { DeviceMessageHandlerService } from './device-message-handler.service';
import { CloudMessagePublisherService } from './cloud-message-publisher.service';
import { AliyunIotBridgeService } from './aliyun-iot-bridge.service';
import { DataProcessorModule } from '../data-processor/data-processor.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { AlarmModule } from '../alarm/alarm.module';

/**
 * MQTT模块
 * 提供MQTT消息处理、路由、设备消息处理、云端消息推送和设备状态同步功能
 */
@Global()
@Module({
  imports: [
    DataProcessorModule,
    DatabaseModule,
    RedisModule,
    WebSocketModule,
    AlarmModule,
  ],
  providers: [
    MqttService,
    MqttRouterService,
    DeviceMessageHandlerService,
    CloudMessagePublisherService,
    AliyunIotBridgeService,
  ],
  exports: [
    MqttService,
    MqttRouterService,
    DeviceMessageHandlerService,
    CloudMessagePublisherService,
    AliyunIotBridgeService,
  ],
})
export class MqttModule {}
