import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { KnowledgeService } from './knowledge.service';

interface KnowledgeSourceConfig {
  title: string;
  relativePath: string;
}

@Injectable()
export class KnowledgeIngestionService {
  private readonly defaultSources: KnowledgeSourceConfig[] = [
    { title: '用户使用手册', relativePath: '../USER_MANUAL.md' },
    { title: '后端 API 设计文档', relativePath: './docs/API_Design.md' },
    { title: 'MQTT 协议设计文档', relativePath: './docs/MQTT_Protocol.md' },
    {
      title: '硬件接口定义文档',
      relativePath: '../firmware/docs/Hardware_Interface.md',
    },
    { title: '睡眠健康指南', relativePath: '../SLEEP_HEALTH_GUIDE.md' },
    { title: '报警与安全指南', relativePath: '../ALARM_SAFETY_GUIDE.md' },
    { title: '用户数据隐私说明', relativePath: '../PRIVACY_POLICY.md' },
    { title: '睡眠监测技术原理', relativePath: '../SLEEP_TECH_BASIS.md' },
  ];

  constructor(private readonly knowledgeService: KnowledgeService) {}

  async ingestDefaultSources() {
    const backendRoot = process.cwd();
    const results = [];

    for (const source of this.defaultSources) {
      const absolutePath = path.resolve(backendRoot, source.relativePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      const relativePath = path.relative(
        path.resolve(backendRoot, '..'),
        absolutePath,
      );
      const checksum = createHash('sha256').update(content).digest('hex');
      const chunks = this.chunkMarkdown(content);

      const result = await this.knowledgeService.indexDocument({
        scope: 'global',
        sourcePath: relativePath.replace(/\\/g, '/'),
        title: source.title,
        checksum,
        metadata: {
          absolutePath,
          ingestedAt: new Date().toISOString(),
        },
        chunks,
      });

      results.push(result);
    }

    return {
      ingestedDocuments: results.length,
      results,
    };
  }

  private chunkMarkdown(content: string) {
    const sections: Array<{ title: string; body: string }> = [];
    const lines = content.split(/\r?\n/);
    let currentTitle = '概览';
    let currentBody: string[] = [];

    const flush = () => {
      const body = currentBody.join('\n').trim();
      if (body) {
        sections.push({ title: currentTitle, body });
      }
      currentBody = [];
    };

    for (const line of lines) {
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
      if (headingMatch) {
        flush();
        currentTitle = headingMatch[2].trim() || '未命名章节';
        continue;
      }
      currentBody.push(line);
    }
    flush();

    const chunks: Array<{
      section: string;
      chunkIndex: number;
      tokenCount: number;
      content: string;
      metadata: Record<string, any>;
    }> = [];

    let chunkIndex = 0;
    for (const section of sections) {
      const paragraphs = section.body
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean);

      let buffer = '';
      for (const paragraph of paragraphs) {
        const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
        if (candidate.length > 1200 && buffer) {
          chunks.push({
            section: section.title,
            chunkIndex,
            tokenCount: this.estimateTokenCount(buffer),
            content: buffer,
            metadata: { paragraphCount: buffer.split(/\n{2,}/).length },
          });
          chunkIndex += 1;
          buffer = paragraph;
          continue;
        }
        buffer = candidate;
      }

      if (buffer) {
        chunks.push({
          section: section.title,
          chunkIndex,
          tokenCount: this.estimateTokenCount(buffer),
          content: buffer,
          metadata: { paragraphCount: buffer.split(/\n{2,}/).length },
        });
        chunkIndex += 1;
      }
    }

    return chunks;
  }

  private estimateTokenCount(content: string) {
    return Math.max(1, Math.ceil(content.length / 4));
  }
}
