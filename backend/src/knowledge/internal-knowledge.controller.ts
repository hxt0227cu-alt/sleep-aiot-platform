import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform, TransformFnParams } from 'class-transformer';
import { timingSafeEqual } from 'node:crypto';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { KnowledgeService } from './knowledge.service';

function trimString(params: TransformFnParams): unknown {
  const value: unknown = params.value;
  return typeof value === 'string' ? value.trim() : value;
}

class InternalKnowledgeSearchDto {
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  query!: string;

  @IsInt()
  @Min(1)
  @Max(20)
  topK = 5;
}

@Controller('internal/knowledge')
export class InternalKnowledgeController {
  private readonly logger = new Logger(InternalKnowledgeController.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly config: ConfigService,
  ) {}

  @Post('search')
  async search(
    @Body() body: InternalKnowledgeSearchDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-trace-id') traceId?: string,
  ) {
    const startedAt = Date.now();
    this.authorize(authorization);
    if (
      !tenantId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        tenantId,
      )
    ) {
      throw new BadRequestException('A valid x-tenant-id header is required');
    }
    const chunks = await this.knowledge.searchSimilarChunks(
      body.query,
      body.topK,
      tenantId,
    );
    this.logger.log(
      JSON.stringify({
        event: 'knowledge.search.completed',
        traceId: traceId || null,
        tenantId,
        topK: body.topK,
        resultCount: chunks.length,
        durationMs: Date.now() - startedAt,
      }),
    );
    return {
      tenantId: tenantId ?? null,
      traceId: traceId ?? null,
      scope: tenantId ? ['global', 'tenant'] : ['global'],
      chunks,
    };
  }

  private authorize(authorization?: string): void {
    const expected = this.config.get<string>('KNOWLEDGE_SERVICE_TOKEN') || '';
    const actual = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    if (
      !expected ||
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new UnauthorizedException('Invalid knowledge service credential');
    }
  }
}
