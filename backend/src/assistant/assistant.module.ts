import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { DeviceModule } from '../device/device.module';
import { SleepModule } from '../sleep/sleep.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { ScheduledDeviceActionExecutorService } from './scheduled-device-action-executor.service';
import { VoiceQueryMqttService } from './voice-query-mqtt.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    DeviceModule,
    SleepModule,
    KnowledgeModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    ScheduledDeviceActionExecutorService,
    VoiceQueryMqttService,
  ],
})
export class AssistantModule {}
