import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  ValidateNested,
} from 'class-validator';

export class SleepRoutineStepDto {
  @IsString()
  id!: string;

  @IsString()
  name!: string;

  @IsInt()
  sortOrder!: number;

  @IsBoolean()
  isFixed!: boolean;

  @IsBoolean()
  enabled!: boolean;
}

export class SleepRoutineTemplateDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SleepRoutineStepDto)
  steps!: SleepRoutineStepDto[];
}
