import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from '../src/database/database.module';
import { KnowledgeIngestionService } from '../src/knowledge/knowledge-ingestion.service';
import { KnowledgeModule } from '../src/knowledge/knowledge.module';
import { ObservabilityModule } from '../src/observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    KnowledgeModule,
    // LlmProviderService 依赖 MetricsService（observability 为 @Global，
    // 完整应用自动解析；CLI 上下文需要显式引入以获得其全局 exports）。
    ObservabilityModule,
  ],
})
class KnowledgeCliModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(KnowledgeCliModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const service = app.get(KnowledgeIngestionService);
    const result = await service.ingestDefaultSources();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
