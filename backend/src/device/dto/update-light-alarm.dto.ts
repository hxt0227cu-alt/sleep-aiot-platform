import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class UpdateLightAlarmDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  time?: string;

  @IsOptional()
  @IsString()
  mode?: string;

  @Transform(({ value, obj }) => value ?? obj.brightness_target)
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  brightnessTarget?: number;

  @Transform(({ value, obj }) => value ?? obj.color_temp_target)
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(2700)
  @Max(6500)
  colorTempTarget?: number;

  @Transform(({ value, obj }) => value ?? obj.ramp_minutes)
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  rampMinutes?: number;

  @Transform(({ value, obj }) => value ?? obj.enabled)
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
