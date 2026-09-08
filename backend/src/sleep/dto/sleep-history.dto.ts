import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SleepHistoryDto {
  @Type(() => Number)
  @IsNumber()
  startTime!: number;

  @Type(() => Number)
  @IsNumber()
  endTime!: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  interval?: number;

  @IsString()
  @IsOptional()
  metrics?: string;
}
