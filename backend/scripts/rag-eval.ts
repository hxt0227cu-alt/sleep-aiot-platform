import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseModule } from '../src/database/database.module';
import { KnowledgeModule } from '../src/knowledge/knowledge.module';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { ObservabilityModule } from '../src/observability/observability.module';

/**
 * RAG 检索评测脚本（章节级真值，IR 意义）
 *
 * 输入：scripts/rag-eval-queries.json（question + target_doc + target_sections[] + category + harder）
 * 输出：202607worklog/rag-evaluation/rag-eval-report.json + 控制台摘要
 *
 * 真值粒度：章节级。命中判定 = 命中文档(sourcePath 文件名匹配 target_doc)
 *           AND 命中章节（chunk.section 与任一 target_sections 规范化后互相包含）。
 *
 * 指标：
 *  - recall@k：top-k 内命中任一目标章节（k 默认 5，可用 RAG_EVAL_TOP_K 覆盖）
 *  - MRR：第一个目标章节命中的位置倒数均值（未命中记 0）
 *  - precision@k：top-k 中命中目标章节的 chunk 数 / k，逐条平均
 *  - docRecall@k（对照）：仅按文档判定命中，用于对照章节级损失的来源
 *  - harder 子集单独统计（难例：口语化/术语变体/模糊问法）
 *
 * 注意：这是真实向量检索评测（searchSimilarChunks → embedText → 外部 embedding API），
 * 不是确定性模拟；运行前需要 OPENAI_API_KEY / OPENAI_BASE_URL 已配置。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    KnowledgeModule,
    // 同 knowledge-ingest：CLI 上下文需要显式引入 observability 模块，
    // 以获得其 @Global 导出的 MetricsService（LlmProviderService 依赖）。
    ObservabilityModule,
  ],
})
class RagEvalCliModule {}

interface EvalQuery {
  question: string;
  target_doc: string;
  target_sections: string[];
  category: string;
  harder: boolean;
}

interface EvalRow {
  question: string;
  category: string;
  harder: boolean;
  target_doc: string;
  target_sections: string[];
  doc_hit: boolean;
  section_hit: boolean;
  rank: number | null;
  top: Array<{ doc: string; section: string }>;
}

function basenameOf(sourcePath: string): string {
  return sourcePath.split('/').pop() ?? sourcePath;
}

function normalizeSection(value: string): string {
  return value.replace(/\s+/g, '');
}

function sectionHit(chunkSection: string, targets: string[]): boolean {
  const norm = normalizeSection(chunkSection);
  return targets.some((target) => {
    const normalizedTarget = normalizeSection(target);
    return (
      normalizedTarget.length > 0 &&
      (norm.includes(normalizedTarget) || normalizedTarget.includes(norm))
    );
  });
}

interface Bucket {
  total: number;
  hits: number;
  docHits: number;
  mrr: number;
  precision: number;
  recallAtK?: number;
  docRecallAtK?: number;
  precisionAtK?: number;
}

function newBucket(): Bucket {
  return { total: 0, hits: 0, docHits: 0, mrr: 0, precision: 0 };
}

function finalizeBucket(bucket: Bucket, k: number): Bucket {
  if (bucket.total === 0) {
    return bucket;
  }
  return {
    ...bucket,
    recallAtK: bucket.hits / bucket.total,
    docRecallAtK: bucket.docHits / bucket.total,
    mrr: bucket.mrr / bucket.total,
    precisionAtK: bucket.precision / bucket.total / k,
  };
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(RagEvalCliModule, {
    logger: ['warn', 'error'],
  });

  try {
    const knowledge = app.get(KnowledgeService);
    const k = Number(process.env.RAG_EVAL_TOP_K ?? 5);
    const queriesPath = path.join(__dirname, 'rag-eval-queries.json');
    const queries: EvalQuery[] = JSON.parse(
      fs.readFileSync(queriesPath, 'utf8'),
    );

    const rows: EvalRow[] = [];

    for (const q of queries) {
      const chunks = await knowledge.searchSimilarChunks(q.question, k);
      const top = chunks.map((chunk) => ({
        doc: basenameOf(chunk.sourcePath),
        section: chunk.section,
      }));
      const docIndex = chunks.findIndex(
        (chunk) => basenameOf(chunk.sourcePath) === q.target_doc,
      );
      const sectionIndex = chunks.findIndex(
        (chunk) =>
          basenameOf(chunk.sourcePath) === q.target_doc &&
          sectionHit(chunk.section, q.target_sections),
      );
      rows.push({
        question: q.question,
        category: q.category,
        harder: q.harder,
        target_doc: q.target_doc,
        target_sections: q.target_sections,
        doc_hit: docIndex >= 0,
        section_hit: sectionIndex >= 0,
        rank: sectionIndex >= 0 ? sectionIndex + 1 : null,
        top,
      });
    }

    const total = rows.length;
    const all = newBucket();
    const byCategory: Record<string, Bucket> = {};
    const harderBucket = newBucket();
    const normalBucket = newBucket();

    for (const row of rows) {
      const buckets = [all];
      buckets.push((byCategory[row.category] ??= newBucket()));
      buckets.push(row.harder ? harderBucket : normalBucket);
      for (const bucket of buckets) {
        bucket.total += 1;
        bucket.hits += row.section_hit ? 1 : 0;
        bucket.docHits += row.doc_hit ? 1 : 0;
        bucket.mrr += row.rank ? 1 / row.rank : 0;
        bucket.precision += row.top.filter(
          (item) =>
            item.doc === row.target_doc &&
            sectionHit(item.section, row.target_sections),
        ).length;
      }
    }

    const report = {
      k,
      ...finalizeBucket(all, k),
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([name, bucket]) => [
          name,
          finalizeBucket(bucket, k),
        ]),
      ),
      harder: finalizeBucket(harderBucket, k),
      normal: finalizeBucket(normalBucket, k),
      generatedAt: new Date().toISOString(),
      rows,
    };

    const outDir = path.resolve(__dirname, '../../202607worklog/rag-evaluation');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'rag-eval-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    const summarize = (bucket: Bucket) => ({
      total: bucket.total,
      recallAtK: Number(((bucket as any).recallAtK ?? 0).toFixed(4)),
      docRecallAtK: Number(((bucket as any).docRecallAtK ?? 0).toFixed(4)),
      mrr: Number(((bucket as any).mrr ?? 0).toFixed(4)),
      precisionAtK: Number(((bucket as any).precisionAtK ?? 0).toFixed(4)),
    });

    console.log(
      JSON.stringify(
        {
          k,
          total,
          overall: summarize(all),
          harder: summarize(harderBucket),
          normal: summarize(normalBucket),
          byCategory: Object.fromEntries(
            Object.entries(byCategory).map(([name, bucket]) => [
              name,
              summarize(finalizeBucket(bucket, k)),
            ]),
          ),
          reportPath: outPath,
          misses: rows
            .filter((row) => !row.section_hit)
            .map((row) => ({
              question: row.question,
              target_doc: row.target_doc,
              target_sections: row.target_sections,
              doc_hit: row.doc_hit,
              top: row.top.slice(0, 5),
            })),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
