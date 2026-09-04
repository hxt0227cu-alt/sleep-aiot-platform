import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SleepTrendDto {
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  days?: number;

  @IsString()
  @IsOptional()
  metric?: string;
}
