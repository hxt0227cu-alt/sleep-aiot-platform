import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LlmProviderService } from '../assistant/llm-provider.service';
import { PromptBuilderService } from '../assistant/prompt-builder.service';
import { ResponseGuardService } from '../assistant/response-guard.service';
import {
  KnowledgeAnswerSource,
  RetrievedKnowledgeChunk,
} from '../assistant/assistant.types';

interface IndexChunkInput {
  section: string;
  chunkIndex: number;
  tokenCount: number;
  content: string;
  metadata?: Record<string, any>;
}

export type KnowledgeScope = 'global' | 'tenant';

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmProvider: LlmProviderService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly responseGuard: ResponseGuardService,
  ) {}

  async answerQuestion(question: string, deviceId?: string, tenantId?: string) {
    let chunks: RetrievedKnowledgeChunk[];
    try {
      chunks = await this.searchSimilarChunks(question, 5, tenantId);
    } catch (error) {
      this.logger.warn(
        `Knowledge retrieval degraded: ${error instanceof Error ? error.name : 'unknown_error'}`,
      );
      return {
        answer: 'Knowledge retrieval is temporarily unavailable.',
        sources: [],
        matchedTopics: [],
        deviceId: deviceId || null,
        degraded: true,
        grounded: false,
      };
    }
    const fallbackSources = this.toSources(chunks);

    if (chunks.length === 0) {
      return {
        answer: '知识库未覆盖这个问题的完整答案。',
        sources: [],
        matchedTopics: [],
        deviceId: deviceId || null,
        degraded: false,
        grounded: false,
      };
    }

    const groundedAnswer = chunks[0].content.slice(0, 500);
    try {
      const prompts = this.promptBuilder.buildKnowledgeAnswerPrompts(
        question,
        chunks,
      );
      const rawContent = await this.llmProvider.generateStructuredJson(prompts);
      const parsed = this.responseGuard.validateKnowledgeAnswer(
        rawContent,
        fallbackSources,
        groundedAnswer,
      );

      return {
        ...parsed,
        deviceId: deviceId || null,
        degraded: false,
        grounded: true,
      };
    } catch (error) {
      this.logger.warn(
        `Knowledge answer model degraded: ${error instanceof Error ? error.name : 'unknown_error'}`,
      );
      return {
        answer: groundedAnswer,
        sources: fallbackSources,
        matchedTopics: [],
        deviceId: deviceId || null,
        degraded: true,
        grounded: true,
      };
    }
  }

  async indexDocument(params: {
    scope?: KnowledgeScope;
    tenantId?: string;
    sourcePath: string;
    title: string;
    version?: string;
    checksum: string;
    metadata?: Record<string, any>;
    chunks: IndexChunkInput[];
  }) {
    const scope = params.scope ?? 'global';
    if (
      (scope === 'global' && params.tenantId) ||
      (scope === 'tenant' && !params.tenantId)
    ) {
      throw new Error('Knowledge scope and tenant ownership are inconsistent');
    }
    const existing = await this.prisma.knowledgeDocument.findFirst({
      where: {
        scope,
        tenantId: params.tenantId ?? null,
        sourcePath: params.sourcePath,
      },
    });
    const data = {
      scope,
      tenantId: params.tenantId ?? null,
      sourcePath: params.sourcePath,
      title: params.title,
      version: params.version,
      checksum: params.checksum,
      metadata: params.metadata,
    };
    const document = existing
      ? await this.prisma.knowledgeDocument.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.knowledgeDocument.create({
          data: {
            ...data,
          },
        });

    await this.prisma.$executeRaw`
      DELETE FROM knowledge_chunks
      WHERE document_id = ${document.id}
    `;

    for (const chunk of params.chunks) {
      const embedding = await this.llmProvider.embedText(chunk.content);
      const vectorLiteral = this.toVectorLiteral(embedding);
      const metadata = JSON.stringify(chunk.metadata ?? {});

      await this.prisma.$executeRaw`
        INSERT INTO knowledge_chunks (
          chunk_id,
          document_id,
          section,
          chunk_index,
          token_count,
          content,
          metadata,
          embedding,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid()::text,
          ${document.id},
          ${chunk.section},
          ${chunk.chunkIndex},
          ${chunk.tokenCount},
          ${chunk.content},
          ${metadata}::jsonb,
          ${vectorLiteral}::vector,
          NOW(),
          NOW()
        )
      `;
    }

    return {
      documentId: document.id,
      title: document.title,
      sourcePath: document.sourcePath,
      chunkCount: params.chunks.length,
    };
  }

  async searchSimilarChunks(question: string, topK = 5, tenantId?: string) {
    const embedding = await this.llmProvider.embedText(question);
    const vectorLiteral = this.toVectorLiteral(embedding);

    const rows = await this.prisma.$queryRaw<
      Array<{
        chunkId: string;
        documentId: string;
        title: string;
        sourcePath: string;
        section: string;
        chunkIndex: number;
        tokenCount: number;
        content: string;
        similarity: number;
      }>
    >`
      SELECT
        kc.chunk_id AS "chunkId",
        kc.document_id AS "documentId",
        kd.title AS "title",
        kd.source_path AS "sourcePath",
        kc.section AS "section",
        kc.chunk_index AS "chunkIndex",
        kc.token_count AS "tokenCount",
        kc.content AS "content",
        1 - (kc.embedding <=> ${vectorLiteral}::vector) AS "similarity"
      FROM knowledge_chunks kc
      INNER JOIN knowledge_documents kd
        ON kd.document_id = kc.document_id
      WHERE kc.embedding IS NOT NULL
        AND (
          kd.scope = 'global'
          OR (kd.scope = 'tenant' AND kd.tenant_id = ${tenantId ?? null})
        )
      ORDER BY kc.embedding <=> ${vectorLiteral}::vector
      LIMIT ${topK}
    `;

    return rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity ?? 0),
    })) as RetrievedKnowledgeChunk[];
  }

  private toSources(
    chunks: RetrievedKnowledgeChunk[],
  ): KnowledgeAnswerSource[] {
    const uniqueSources = new Map<string, KnowledgeAnswerSource>();

    for (const chunk of chunks) {
      const key = `${chunk.sourcePath}:${chunk.section}`;
      if (!uniqueSources.has(key)) {
        uniqueSources.set(key, {
          title: chunk.title,
          path: chunk.sourcePath,
          section: chunk.section,
        });
      }
    }

    return Array.from(uniqueSources.values());
  }

  private toVectorLiteral(embedding: number[]) {
    return `[${embedding.map((value) => Number(value).toFixed(8)).join(',')}]`;
  }
}
