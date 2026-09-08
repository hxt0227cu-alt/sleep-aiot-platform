import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class ExplainSleepReportDto {
  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsString()
  @IsNotEmpty()
  question!: string;
}
