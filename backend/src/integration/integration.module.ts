import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OutboxService } from './outbox.service';
import { AgentDispatcherService } from './agent-dispatcher.service';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [OutboxService, AgentDispatcherService],
  exports: [OutboxService, AgentDispatcherService],
})
export class IntegrationModule {}
