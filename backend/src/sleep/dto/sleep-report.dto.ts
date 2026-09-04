import { IsString, IsOptional, IsDateString } from 'class-validator';

export class SleepReportDto {
  @IsString()
  @IsOptional()
  date?: string;
}
