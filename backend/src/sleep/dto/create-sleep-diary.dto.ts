import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSleepDiaryDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  bedTime!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  wakeTime!: string;

  @IsInt()
  @Min(0)
  fallAsleepMinutes!: number;

  @IsString()
  @IsIn(['excellent', 'good', 'poor'])
  quality!: string;

  @IsString()
  @MaxLength(2000)
  summary!: string;
}
