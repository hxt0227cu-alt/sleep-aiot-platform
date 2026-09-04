import { Module } from '@nestjs/common';
import { AlarmService } from './alarm.service';
import { AlarmNotificationService } from './alarm-notification.service';
import { AlarmRuleEngineService } from './alarm-rule-engine.service';
import { AlarmStateService } from './alarm-state.service';
import { EmergencyContactService } from './emergency-contact.service';
import { AlarmController } from './alarm.controller';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [AuthModule, DatabaseModule, WebSocketModule],
  controllers: [AlarmController],
  providers: [
    AlarmService,
    AlarmNotificationService,
    AlarmRuleEngineService,
    AlarmStateService,
    EmergencyContactService,
  ],
  exports: [
    AlarmService,
    AlarmNotificationService,
    AlarmRuleEngineService,
    AlarmStateService,
    EmergencyContactService,
  ],
})
export class AlarmModule {}
