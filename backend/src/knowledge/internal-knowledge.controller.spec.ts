import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InternalKnowledgeController } from './internal-knowledge.controller';
import { KnowledgeService } from './knowledge.service';

describe('InternalKnowledgeController', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const knowledge = { searchSimilarChunks: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === 'KNOWLEDGE_SERVICE_TOKEN' ? 'service-secret' : undefined,
    ),
  };
  let app: INestApplication;
  let httpServer: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalKnowledgeController],
      providers: [
        { provide: KnowledgeService, useValue: knowledge },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    httpServer = app.getHttpServer() as App;
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('binds retrieval to the caller tenant and trace id', async () => {
    knowledge.searchSimilarChunks.mockResolvedValue([{ chunkId: 'c1' }]);
    const response = await request(httpServer)
      .post('/internal/knowledge/search')
      .set('authorization', 'Bearer service-secret')
      .set('x-tenant-id', tenantId)
      .set('x-trace-id', 'trace-123')
      .send({ query: 'sleep', topK: 3 })
      .expect(201);
    expect(knowledge.searchSimilarChunks).toHaveBeenCalledWith(
      'sleep',
      3,
      tenantId,
    );
    expect(response.text).toContain('"traceId":"trace-123"');
  });

  it('rejects missing service credentials before retrieval', async () => {
    await request(httpServer)
      .post('/internal/knowledge/search')
      .set('x-tenant-id', tenantId)
      .send({ query: 'sleep', topK: 3 })
      .expect(401);
    expect(knowledge.searchSimilarChunks).not.toHaveBeenCalled();
  });

  it('rejects an invalid service credential before retrieval', async () => {
    await request(httpServer)
      .post('/internal/knowledge/search')
      .set('authorization', 'Bearer wrong-secret')
      .set('x-tenant-id', tenantId)
      .send({ query: 'sleep', topK: 3 })
      .expect(401);
    expect(knowledge.searchSimilarChunks).not.toHaveBeenCalled();
  });

  it('rejects missing tenant context before retrieval', async () => {
    await request(httpServer)
      .post('/internal/knowledge/search')
      .set('authorization', 'Bearer service-secret')
      .send({ query: 'sleep', topK: 3 })
      .expect(400);
    expect(knowledge.searchSimilarChunks).not.toHaveBeenCalled();
  });

  it.each([
    [{ query: '', topK: 3 }, 'empty query'],
    [{ query: '   ', topK: 3 }, 'blank query'],
    [{ query: 'x'.repeat(2001), topK: 3 }, 'oversized query'],
    [{ query: 'sleep', topK: 0 }, 'topK below minimum'],
    [{ query: 'sleep', topK: 21 }, 'topK above maximum'],
  ])('rejects %s at the HTTP boundary', async (body) => {
    await request(httpServer)
      .post('/internal/knowledge/search')
      .set('authorization', 'Bearer service-secret')
      .set('x-tenant-id', tenantId)
      .send(body)
      .expect(400);
    expect(knowledge.searchSimilarChunks).not.toHaveBeenCalled();
  });
});
