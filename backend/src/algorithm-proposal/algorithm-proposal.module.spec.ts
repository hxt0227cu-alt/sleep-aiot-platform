import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AlgorithmProposalModule } from './algorithm-proposal.module';

describe('AlgorithmProposalModule dependency wiring', () => {
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'algorithm-proposal-module-test-secret';
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  it('compiles with the controller JwtAuthGuard dependency resolved', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AlgorithmProposalModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({
        duplicate: () => ({ on: jest.fn(), quit: jest.fn() }),
        getClient: () => ({ publish: jest.fn() }),
      })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
