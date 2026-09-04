import { Injectable } from '@nestjs/common';
import { RetrievedKnowledgeChunk } from './assistant.types';

@Injectable()
export class PromptBuilderService {
  buildSleepReportExplanationPrompts(
    question: string,
    report: Record<string, any>,
  ) {
    return {
      systemPrompt: [
        '你是智能助眠系统的睡眠报告解读助手。',
        '请使用中文回答，语气专业、温和、清晰。',
        '你可以解释睡眠评分、睡眠结构、睡眠效率、心率和呼吸率。',
        '不要做明确医疗诊断，但在指标明显异常时可以提示继续观察、改善环境或必要时咨询医生。',
        '必须严格返回 JSON，对象字段为 answer, keyFindings, recommendations, caution。',
        'keyFindings 和 recommendations 必须是字符串数组，caution 为字符串或空字符串。',
      ].join('\n'),
      userPrompt: [
        `用户问题：${question}`,
        '这是结构化睡眠报告，请根据数据直接解释，不要编造缺失指标：',
        JSON.stringify(report, null, 2),
      ].join('\n\n'),
    };
  }

  buildDeviceControlPrompts(text: string) {
    return {
      systemPrompt: [
        '你是智能助眠设备控制助手。',
        '你只能通过一个函数调用来表达控制意图，不能输出自然语言。',
        '优先选择最贴合用户请求的单个函数。',
        '设备支持灯光亮度、色温、白噪音播放/停止、音量。',
        '如果用户提到“助眠”“睡眠模式”，优先用 set_sleep_mode。',
        '如果用户提到“30分钟后关闭”“稍后关闭”等延时信息，只能放到 set_sleep_mode.duration_minutes 中。',
        'sound 仅在需要播放声音时提供。',
      ].join('\n'),
      userPrompt: `请解析这条设备控制指令：${text}`,
    };
  }

  buildKnowledgeAnswerPrompts(
    question: string,
    chunks: RetrievedKnowledgeChunk[],
  ) {
    const context = chunks
      .map(
        (chunk, index) =>
          `片段 ${index + 1}\n来源标题：${chunk.title}\n来源路径：${chunk.sourcePath}\n章节：${chunk.section}\n内容：${chunk.content}`,
      )
      .join('\n\n');

    return {
      systemPrompt: [
        '你是智能助眠产品知识库问答助手。',
        '你必须仅基于提供的检索片段回答。',
        '如果片段不足以支持完整回答，请明确说“知识库未覆盖这个问题的完整答案”。',
        '必须严格返回 JSON，对象字段为 answer, matchedTopics。',
        'matchedTopics 必须是字符串数组。',
      ].join('\n'),
      userPrompt: [
        `用户问题：${question}`,
        '下面是检索到的知识库片段，请基于它们作答：',
        context,
      ].join('\n\n'),
    };
  }
}
