export type AssistantToolName =
  'set_sleep_mode' | 'light_control' | 'audio_control';

export interface AssistantToolCall {
  name: AssistantToolName;
  arguments: Record<string, any>;
  rawToolCallId?: string;
}

export interface AssistantImmediateCommand {
  command: string;
  params: Record<string, any>;
  timeout?: number;
  summary: string;
}

export interface AssistantScheduledActionPlan {
  actionType: string;
  command: string;
  params: Record<string, any>;
  delayMinutes: number;
  executeAt: Date;
  summary: string;
}

export interface AssistantDeviceExecutionPlan {
  toolCall: AssistantToolCall;
  immediateCommands: AssistantImmediateCommand[];
  scheduledActions: AssistantScheduledActionPlan[];
  summary: string[];
}

export interface RetrievedKnowledgeChunk {
  chunkId: string;
  documentId: string;
  title: string;
  sourcePath: string;
  section: string;
  chunkIndex: number;
  tokenCount: number;
  content: string;
  similarity: number;
}

export interface KnowledgeAnswerSource {
  title: string;
  path: string;
  section: string;
}
