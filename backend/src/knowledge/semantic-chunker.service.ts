import { Injectable, Logger } from '@nestjs/common';

/**
 * 语义分块服务
 *
 * 基于语义边界拆分文档，避免语义断裂，提升召回准确率。
 *
 * 分块策略：
 * 1. 按段落/标题初步分割
 * 2. 基于语义相似度合并相邻段落
 * 3. 控制分块大小在目标范围内
 * 4. 保留上下文重叠（overlap）
 */
@Injectable()
export class SemanticChunkerService {
  private readonly logger = new Logger(SemanticChunkerService.name);

  /** 目标分块大小（字符数） */
  private readonly TARGET_CHUNK_SIZE = 800;

  /** 最小分块大小 */
  private readonly MIN_CHUNK_SIZE = 200;

  /** 最大分块大小 */
  private readonly MAX_CHUNK_SIZE = 1200;

  /** 分块重叠大小 */
  private readonly CHUNK_OVERLAP = 100;

  /** 语义相似度阈值（低于此值则分割） */
  private readonly SEMANTIC_SPLIT_THRESHOLD = 0.3;

  /**
   * 将文档分割成语义块
   *
   * @param document 文档内容
   * @param options 分块选项
   * @returns 语义块列表
   */
  chunk(document: string, options?: ChunkOptions): TextChunk[] {
    if (!document || document.trim().length === 0) {
      return [];
    }

    const targetSize = options?.targetSize || this.TARGET_CHUNK_SIZE;
    const minSize = options?.minSize || this.MIN_CHUNK_SIZE;
    const maxSize = options?.maxSize || this.MAX_CHUNK_SIZE;
    const overlap = options?.overlap || this.CHUNK_OVERLAP;

    this.logger.debug(
      `语义分块开始: documentLength=${document.length}, targetSize=${targetSize}`,
    );

    // 1. 按结构初步分割（标题、段落、列表）
    const segments = this.structuralSplit(document);

    // 2. 基于语义边界合并/分割
    const semanticChunks = this.semanticMerge(
      segments,
      targetSize,
      minSize,
      maxSize,
    );

    // 3. 添加重叠
    const chunksWithOverlap = this.addOverlap(semanticChunks, overlap);

    // 4. 生成元数据
    const result = chunksWithOverlap.map((chunk, index) => ({
      id: `chunk-${Date.now()}-${index}`,
      content: chunk.content,
      index,
      startPosition: chunk.startPosition,
      endPosition: chunk.endPosition,
      length: chunk.content.length,
      metadata: {
        heading: chunk.heading,
        section: chunk.section,
        source: options?.source || 'unknown',
      },
    }));

    this.logger.debug(`语义分块完成: ${result.length} 个块`);
    return result;
  }

  /**
   * 按结构分割文档
   */
  private structuralSplit(document: string): DocumentSegment[] {
    const segments: DocumentSegment[] = [];
    const lines = document.split('\n');
    let currentContent = '';
    let currentHeading = '';
    let currentSection = '';
    let startPosition = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const position = document.indexOf(line, startPosition);

      // 检测标题
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        // 保存当前段落
        if (currentContent.trim().length > 0) {
          segments.push({
            content: currentContent.trim(),
            heading: currentHeading,
            section: currentSection,
            startPosition,
            endPosition: position,
          });
        }
        currentHeading = headingMatch[2].trim();
        currentSection = headingMatch[2].trim();
        currentContent = '';
        startPosition = position + line.length;
        continue;
      }

      // 检测空行（段落分隔）
      if (line.trim() === '' && currentContent.trim().length > 0) {
        if (currentContent.length >= this.MIN_CHUNK_SIZE / 2) {
          segments.push({
            content: currentContent.trim(),
            heading: currentHeading,
            section: currentSection,
            startPosition,
            endPosition: position,
          });
          currentContent = '';
          startPosition = position + line.length;
        } else {
          currentContent += '\n';
        }
        continue;
      }

      currentContent += (currentContent ? '\n' : '') + line;
    }

    // 保存最后一段
    if (currentContent.trim().length > 0) {
      segments.push({
        content: currentContent.trim(),
        heading: currentHeading,
        section: currentSection,
        startPosition,
        endPosition: document.length,
      });
    }

    return segments;
  }

  /**
   * 基于语义边界合并段落
   */
  private semanticMerge(
    segments: DocumentSegment[],
    targetSize: number,
    minSize: number,
    maxSize: number,
  ): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];
    let currentChunk: SemanticChunk | null = null;

    for (const segment of segments) {
      // 如果当前块为空，创建新块
      if (!currentChunk) {
        currentChunk = {
          content: segment.content,
          heading: segment.heading,
          section: segment.section,
          startPosition: segment.startPosition,
          endPosition: segment.endPosition,
        };
        continue;
      }

      // 计算合并后的大小
      const mergedSize =
        currentChunk.content.length + segment.content.length + 2; // +2 for newline

      // 如果当前块已经足够大，保存并创建新块
      if (currentChunk.content.length >= targetSize) {
        chunks.push(currentChunk);
        currentChunk = {
          content: segment.content,
          heading: segment.heading,
          section: segment.section,
          startPosition: segment.startPosition,
          endPosition: segment.endPosition,
        };
        continue;
      }

      // 检查语义相似度（简化实现：基于标题/章节是否相同）
      const semanticallyRelated = this.checkSemanticRelation(
        currentChunk,
        segment,
      );

      // 如果语义相关且合并后不超过最大大小，则合并
      if (semanticallyRelated && mergedSize <= maxSize) {
        currentChunk.content += '\n\n' + segment.content;
        currentChunk.endPosition = segment.endPosition;
      } else if (mergedSize > maxSize) {
        // 合并后太大，保存当前块并分割大段
        chunks.push(currentChunk);
        if (segment.content.length > maxSize) {
          // 分割超大段落
          const subChunks = this.splitLargeSegment(
            segment,
            targetSize,
            maxSize,
          );
          chunks.push(...subChunks);
          currentChunk = null;
        } else {
          currentChunk = {
            content: segment.content,
            heading: segment.heading,
            section: segment.section,
            startPosition: segment.startPosition,
            endPosition: segment.endPosition,
          };
        }
      } else {
        // 语义不相关，保存当前块并创建新块
        chunks.push(currentChunk);
        currentChunk = {
          content: segment.content,
          heading: segment.heading,
          section: segment.section,
          startPosition: segment.startPosition,
          endPosition: segment.endPosition,
        };
      }
    }

    // 保存最后一块
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    // 合并过小的块
    return this.mergeSmallChunks(chunks, minSize, maxSize);
  }

  /**
   * 检查两个段落是否语义相关
   */
  private checkSemanticRelation(
    chunk: SemanticChunk,
    segment: DocumentSegment,
  ): boolean {
    // 相同标题/章节视为相关
    if (chunk.heading && segment.heading && chunk.heading === segment.heading) {
      return true;
    }
    if (chunk.section && segment.section && chunk.section === segment.section) {
      return true;
    }
    // 都没有标题，默认相关（连续段落）
    if (!chunk.heading && !segment.heading) {
      return true;
    }
    return false;
  }

  /**
   * 分割超大段落
   */
  private splitLargeSegment(
    segment: DocumentSegment,
    targetSize: number,
    maxSize: number,
  ): SemanticChunk[] {
    const chunks: SemanticChunk[] = [];
    const sentences = segment.content.split(/(?<=[。！？.!?])\s*/);
    let currentContent = '';
    let currentStart = segment.startPosition;

    for (const sentence of sentences) {
      if (
        currentContent.length + sentence.length > targetSize &&
        currentContent.length > 0
      ) {
        chunks.push({
          content: currentContent,
          heading: segment.heading,
          section: segment.section,
          startPosition: currentStart,
          endPosition: currentStart + currentContent.length,
        });
        currentStart += currentContent.length;
        currentContent = sentence;
      } else {
        currentContent += (currentContent ? ' ' : '') + sentence;
      }
    }

    if (currentContent) {
      chunks.push({
        content: currentContent,
        heading: segment.heading,
        section: segment.section,
        startPosition: currentStart,
        endPosition: segment.endPosition,
      });
    }

    return chunks;
  }

  /**
   * 合并过小的块
   */
  private mergeSmallChunks(
    chunks: SemanticChunk[],
    minSize: number,
    maxSize: number,
  ): SemanticChunk[] {
    if (chunks.length <= 1) return chunks;

    const result: SemanticChunk[] = [];
    let i = 0;

    while (i < chunks.length) {
      const current = { ...chunks[i] };

      // 如果当前块太小，尝试合并下一个
      while (current.content.length < minSize && i + 1 < chunks.length) {
        const next = chunks[i + 1];
        if (current.content.length + next.content.length <= maxSize) {
          current.content += '\n\n' + next.content;
          current.endPosition = next.endPosition;
          i++;
        } else {
          break;
        }
      }

      result.push(current);
      i++;
    }

    return result;
  }

  /**
   * 为分块添加重叠
   */
  private addOverlap(
    chunks: SemanticChunk[],
    overlapSize: number,
  ): SemanticChunk[] {
    if (chunks.length <= 1 || overlapSize <= 0) return chunks;

    return chunks.map((chunk, index) => {
      if (index === 0) return chunk;

      const previousChunk = chunks[index - 1];
      const overlapContent = previousChunk.content.slice(-overlapSize);

      return {
        ...chunk,
        content: overlapContent + '\n\n' + chunk.content,
        startPosition: Math.max(0, chunk.startPosition - overlapSize),
      };
    });
  }
}

/**
 * 分块选项
 */
export interface ChunkOptions {
  targetSize?: number;
  minSize?: number;
  maxSize?: number;
  overlap?: number;
  source?: string;
}

/**
 * 文本块
 */
export interface TextChunk {
  id: string;
  content: string;
  index: number;
  startPosition: number;
  endPosition: number;
  length: number;
  metadata: {
    heading?: string;
    section?: string;
    source: string;
  };
}

/**
 * 文档段落
 */
interface DocumentSegment {
  content: string;
  heading: string;
  section: string;
  startPosition: number;
  endPosition: number;
}

/**
 * 语义块
 */
interface SemanticChunk {
  content: string;
  heading: string;
  section: string;
  startPosition: number;
  endPosition: number;
}
