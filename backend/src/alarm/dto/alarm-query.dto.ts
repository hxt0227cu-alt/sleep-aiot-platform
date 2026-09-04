import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { AlarmLevel } from './alarm-config.dto';

export class AlarmQueryDto {
  @IsString()
  @IsOptional()
  deviceId?: string;

  @IsDateString()
  @IsOptional()
  startTime?: string;

  @IsDateString()
  @IsOptional()
  endTime?: string;

  @IsEnum(AlarmLevel)
  @IsOptional()
  level?: AlarmLevel;

  @IsNumber()
  @IsOptional()
  page?: number;

  @IsNumber()
  @IsOptional()
  pageSize?: number;
}
