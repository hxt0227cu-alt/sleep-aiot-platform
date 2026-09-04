import { BadRequestException } from '@nestjs/common';
import { AssistantToolName } from './assistant.types';
import { ResponseGuardService } from './response-guard.service';

describe('ResponseGuardService', () => {
  const service = new ResponseGuardService();

  it('parses valid sleep explanation JSON', () => {
    const result = service.validateSleepExplanation(
      JSON.stringify({
        answer: '睡眠质量一般。',
        keyFindings: ['深睡偏少'],
        recommendations: ['今晚调暗灯光'],
        caution: '如持续异常请继续观察',
      }),
    );

    expect(result.answer).toBe('睡眠质量一般。');
    expect(result.keyFindings).toEqual(['深睡偏少']);
    expect(result.recommendations).toEqual(['今晚调暗灯光']);
  });

  it('rejects unsupported tool names', () => {
    expect(() =>
      service.validateToolCall({
        name: 'reboot' as AssistantToolName,
        arguments: {},
      }),
    ).toThrow(BadRequestException);
  });

  it('keeps the grounded retrieval answer when the model invents a claim', () => {
    const result = service.validateKnowledgeAnswer(
      JSON.stringify({
        answer: 'The model invented an unsupported diagnosis.',
        matchedTopics: ['sleep'],
      }),
      [{ title: 'Sleep guide', path: 'guide.md', section: 'Routine' }],
      'Keep a stable wake time.',
    );

    expect(result.answer).toBe('Keep a stable wake time.');
    expect(result.sources).toEqual([
      { title: 'Sleep guide', path: 'guide.md', section: 'Routine' },
    ]);
  });
});
