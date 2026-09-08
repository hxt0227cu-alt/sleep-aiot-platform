import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
} from 'class-validator';

export enum AlarmLevel {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

export enum AlarmStatus {
  PENDING = 'pending',
  HANDLED = 'handled',
  IGNORED = 'ignored',
}

export class CreateAlarmDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsEnum(AlarmLevel)
  @IsNotEmpty()
  level!: AlarmLevel;

  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsNumber()
  @IsOptional()
  value?: number;

  @IsNumber()
  @IsOptional()
  threshold?: number;

  @IsDateString()
  @IsNotEmpty()
  timestamp!: string;
}
