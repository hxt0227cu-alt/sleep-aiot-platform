import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from './knowledge.service';

const databaseUrl = process.env.RAG_PGVECTOR_DATABASE_URL;
const describePgvector = databaseUrl ? describe : describe.skip;

describePgvector('KnowledgeService pgvector tenant isolation', () => {
  const tenantA = '11111111-1111-4111-8111-111111111111';
  const tenantB = '22222222-2222-4222-8222-222222222222';
  const sourcePrefix = 'rag-evidence-20260804/';
  let prisma: PrismaService;
  let service: KnowledgeService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl!;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, name: 'RAG evidence tenant A' },
        { id: tenantB, name: 'RAG evidence tenant B' },
      ],
      skipDuplicates: true,
    });

    const llmProvider = {
      embedText: jest.fn().mockResolvedValue([1, 0, 0]),
      generateStructuredJson: jest.fn(),
    };
    service = new KnowledgeService(
      prisma,
      llmProvider as never,
      { buildKnowledgeAnswerPrompts: jest.fn() } as never,
      { validateKnowledgeAnswer: jest.fn() } as never,
    );

    await service.indexDocument({
      scope: 'global',
      sourcePath: `${sourcePrefix}global.md`,
      title: 'Global sleep guidance',
      checksum: 'global-checksum',
      chunks: [
        {
          section: 'Global',
          chunkIndex: 0,
          tokenCount: 6,
          content: 'Keep a stable wake time.',
        },
      ],
    });
    await service.indexDocument({
      scope: 'tenant',
      tenantId: tenantA,
      sourcePath: `${sourcePrefix}tenant-a.md`,
      title: 'Tenant A handbook',
      checksum: 'tenant-a-checksum',
      chunks: [
        {
          section: 'Private A',
          chunkIndex: 0,
          tokenCount: 6,
          content: 'Tenant A private sleep policy.',
        },
      ],
    });
    await service.indexDocument({
      scope: 'tenant',
      tenantId: tenantB,
      sourcePath: `${sourcePrefix}tenant-b.md`,
      title: 'Tenant B handbook',
      checksum: 'tenant-b-checksum',
      chunks: [
        {
          section: 'Private B',
          chunkIndex: 0,
          tokenCount: 6,
          content: 'Tenant B private sleep policy.',
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.knowledgeDocument.deleteMany({
      where: { sourcePath: { startsWith: sourcePrefix } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await prisma.$disconnect();
  });

  it('tenant A sees only global and tenant A documents', async () => {
    const chunks = await service.searchSimilarChunks(
      'sleep policy',
      10,
      tenantA,
    );
    expect(new Set(chunks.map((chunk) => chunk.sourcePath))).toEqual(
      new Set([`${sourcePrefix}global.md`, `${sourcePrefix}tenant-a.md`]),
    );
  });

  it('tenant B sees only global and tenant B documents', async () => {
    const chunks = await service.searchSimilarChunks(
      'sleep policy',
      10,
      tenantB,
    );
    expect(new Set(chunks.map((chunk) => chunk.sourcePath))).toEqual(
      new Set([`${sourcePrefix}global.md`, `${sourcePrefix}tenant-b.md`]),
    );
  });
});
