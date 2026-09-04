import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { SleepRoutineStepDto } from './sleep-routine-template.dto';

export class CreateSleepRoutineRecordDto {
  @IsDateString()
  date: string;

  @IsDateString()
  startedAt: string;

  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SleepRoutineStepDto)
  stepsSnapshot: SleepRoutineStepDto[];

  @IsBoolean()
  finished: boolean;
}
