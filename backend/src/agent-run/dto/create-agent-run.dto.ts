import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAgentRunDto {
  @IsIn([
    'sleep_analysis',
    'knowledge_answer',
    'device_control',
    'ops_diagnosis',
    'sleep_report',
    'sleep_improvement',
    'voice_companion',
    'algorithm_optimization',
  ])
  agentType!: string;

  @IsObject()
  input!: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  workflowVersion?: string;
}
