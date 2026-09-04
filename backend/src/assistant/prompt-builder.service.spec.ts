import { PromptBuilderService } from './prompt-builder.service';

describe('PromptBuilderService', () => {
  const service = new PromptBuilderService();

  it('includes the user question and report fields in sleep explanation prompts', () => {
    const prompts = service.buildSleepReportExplanationPrompts(
      '为什么睡不好？',
      {
        sleep_score: 68,
        vital_signs: {
          avg_breathing_rate: 22,
        },
      },
    );

    expect(prompts.systemPrompt).toContain('必须严格返回 JSON');
    expect(prompts.userPrompt).toContain('为什么睡不好？');
    expect(prompts.userPrompt).toContain('sleep_score');
    expect(prompts.userPrompt).toContain('avg_breathing_rate');
  });
});
