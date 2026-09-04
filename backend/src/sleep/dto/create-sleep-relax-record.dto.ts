import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSleepRelaxRecordDto {
  @IsString()
  @IsIn(['breathing', 'muscle', 'meditation'])
  methodId: string;

  @IsString()
  @MaxLength(100)
  methodName: string;

  @IsInt()
  @Min(1)
  durationSeconds: number;

  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}
