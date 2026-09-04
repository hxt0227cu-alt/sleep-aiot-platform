import { LlmProviderService } from '../assistant/llm-provider.service';
import { PromptBuilderService } from '../assistant/prompt-builder.service';
import { ResponseGuardService } from '../assistant/response-guard.service';
import { RetrievedKnowledgeChunk } from '../assistant/assistant.types';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService', () => {
  const queryRaw = jest.fn<
    Promise<RetrievedKnowledgeChunk[]>,
    [TemplateStringsArray, ...unknown[]]
  >();
  const embedText = jest.fn<Promise<number[]>, [string]>();
  const generateStructuredJson = jest.fn<Promise<string>, [unknown]>();
  const buildKnowledgeAnswerPrompts = jest.fn<
    unknown,
    [string, RetrievedKnowledgeChunk[]]
  >();
  const validateKnowledgeAnswer = jest.fn<
    unknown,
    [string, unknown[], string]
  >();

  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const llmProvider = {
    embedText,
    generateStructuredJson,
  } as unknown as LlmProviderService;
  const promptBuilder = {
    buildKnowledgeAnswerPrompts,
  } as unknown as PromptBuilderService;
  const responseGuard = {
    validateKnowledgeAnswer,
  } as unknown as ResponseGuardService;

  const service = new KnowledgeService(
    prisma,
    llmProvider,
    promptBuilder,
    responseGuard,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns top-k chunks from vector search results', async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryRaw.mockResolvedValue([
      {
        chunkId: 'chunk_1',
        documentId: 'doc_1',
        title: '用户使用手册',
        sourcePath: 'USER_MANUAL.md',
        section: '重新配网',
        chunkIndex: 0,
        tokenCount: 120,
        content: '长按设备按钮 3 秒进入配网模式。',
        similarity: 0.93,
      },
    ]);

    const chunks = await service.searchSimilarChunks('设备怎么重新配网？');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sourcePath).toBe('USER_MANUAL.md');
    expect(chunks[0].similarity).toBe(0.93);
  });

  it('passes the tenant boundary into vector retrieval', async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryRaw.mockResolvedValue([]);

    await service.searchSimilarChunks('企业睡眠制度', 3, 'tenant-a');

    const call = queryRaw.mock.calls[0];
    expect(call.slice(1)).toContain('tenant-a');
    expect(call.slice(1)).toContain(3);
  });

  it('degrades with empty citations when vector retrieval fails', async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryRaw.mockRejectedValue(new Error('database timeout'));

    const result = await service.answerQuestion('sleep', undefined, 'tenant-a');

    expect(result.degraded).toBe(true);
    expect(result.grounded).toBe(false);
    expect(result.sources).toEqual([]);
    expect(generateStructuredJson).not.toHaveBeenCalled();
  });

  it('refuses a deterministic conclusion when retrieval has no evidence', async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryRaw.mockResolvedValue([]);

    const result = await service.answerQuestion(
      'unknown',
      undefined,
      'tenant-a',
    );

    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(false);
    expect(generateStructuredJson).not.toHaveBeenCalled();
  });

  it('falls back to retrieved text when the answer model fails', async () => {
    embedText.mockResolvedValue([0.1, 0.2, 0.3]);
    queryRaw.mockResolvedValue([
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        title: 'Sleep guide',
        sourcePath: 'guide.md',
        section: 'Routine',
        chunkIndex: 0,
        tokenCount: 8,
        content: 'Keep a stable wake time.',
        similarity: 0.9,
      },
    ]);
    buildKnowledgeAnswerPrompts.mockReturnValue([]);
    generateStructuredJson.mockRejectedValue(new Error('provider timeout'));

    const result = await service.answerQuestion(
      'routine',
      undefined,
      'tenant-a',
    );

    expect(result.answer).toBe('Keep a stable wake time.');
    expect(result.sources).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.grounded).toBe(true);
  });
});
