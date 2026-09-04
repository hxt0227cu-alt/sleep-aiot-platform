import {
  IsBoolean,
  IsNumber,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class SleepPlanDto {
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  bedTime: string;

  @IsNumber()
  @Min(0)
  @Max(24)
  sleepDuration: number;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  wakeTime: string;

  @IsBoolean()
  reminderEnabled: boolean;
}
