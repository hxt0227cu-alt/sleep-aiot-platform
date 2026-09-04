import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { MqttModule } from './mqtt/mqtt.module';
import { AuthModule } from './auth/auth.module';
import { DeviceModule } from './device/device.module';
import { SleepModule } from './sleep/sleep.module';
import { AlarmModule } from './alarm/alarm.module';
import { UserModule } from './user/user.module';
import { OtaModule } from './ota/ota.module';
import { VoiceModule } from './voice/voice.module';
import { WebSocketModule } from './websocket/websocket.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AssistantModule } from './assistant/assistant.module';
import { ObservabilityModule } from './observability/observability.module';
import { TenantModule } from './tenant/tenant.module';
import { AgentRunModule } from './agent-run/agent-run.module';
import { validateEnvironment } from './config/env.validation';
import { IntegrationModule } from './integration/integration.module';
import { AlgorithmProposalModule } from './algorithm-proposal/algorithm-proposal.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    RedisModule,
    MqttModule,
    AuthModule,
    DeviceModule,
    SleepModule,
    AlarmModule,
    UserModule,
    OtaModule,
    VoiceModule,
    WebSocketModule,
    DashboardModule,
    AssistantModule,
    ObservabilityModule,
    TenantModule,
    AgentRunModule,
    IntegrationModule,
    AlgorithmProposalModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
