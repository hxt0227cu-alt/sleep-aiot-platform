import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsEnum,
} from 'class-validator';

export enum AlarmType {
  HEART_RATE_HIGH = 'heart_rate_high',
  HEART_RATE_LOW = 'heart_rate_low',
  BREATHING_RATE_HIGH = 'breathing_rate_high',
  BREATHING_RATE_LOW = 'breathing_rate_low',
  NO_MOVEMENT = 'no_movement',
}

export enum AlarmLevel {
  CRITICAL = 'critical',
  WARNING = 'warning',
  INFO = 'info',
}

export class AlarmRuleDto {
  @IsEnum(AlarmType)
  type: AlarmType;

  @IsBoolean()
  enabled: boolean;

  @IsNumber()
  threshold: number;

  @IsNumber()
  @IsOptional()
  duration?: number;

  @IsArray()
  @IsString({ each: true })
  actions: string[];
}

export class AlarmConfigDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsArray()
  rules: AlarmRuleDto[];
}
