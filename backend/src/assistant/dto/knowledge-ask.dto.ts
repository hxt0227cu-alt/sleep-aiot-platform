import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class KnowledgeAskDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsString()
  @IsOptional()
  deviceId?: string;
}
