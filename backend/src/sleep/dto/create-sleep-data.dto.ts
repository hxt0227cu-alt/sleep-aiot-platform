import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
} from 'class-validator';

export class CreateSleepDataDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsDateString()
  @IsNotEmpty()
  timestamp: string;

  @IsNumber()
  @IsOptional()
  heartRate?: number;

  @IsNumber()
  @IsOptional()
  breathingRate?: number;

  @IsNumber()
  @IsOptional()
  movement?: number;

  @IsString()
  @IsOptional()
  sleepState?: string;
}
