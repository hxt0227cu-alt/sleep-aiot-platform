import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DeviceControlMapperService } from '../assistant/device-control-mapper.service';
import { LlmProviderService } from '../assistant/llm-provider.service';
import { PromptBuilderService } from '../assistant/prompt-builder.service';
import { ResponseGuardService } from '../assistant/response-guard.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { InternalKnowledgeController } from './internal-knowledge.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [InternalKnowledgeController],
  providers: [
    DeviceControlMapperService,
    LlmProviderService,
    PromptBuilderService,
    ResponseGuardService,
    KnowledgeService,
    KnowledgeIngestionService,
  ],
  exports: [
    DeviceControlMapperService,
    LlmProviderService,
    PromptBuilderService,
    ResponseGuardService,
    KnowledgeService,
    KnowledgeIngestionService,
  ],
})
export class KnowledgeModule {}
