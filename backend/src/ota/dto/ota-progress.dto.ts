import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsOptional,
} from 'class-validator';

export enum OtaStatus {
  DOWNLOADING = 'downloading',
  INSTALLING = 'installing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export class OtaProgressDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsNotEmpty()
  version: string;

  @IsNumber()
  progress: number;

  @IsEnum(OtaStatus)
  status: OtaStatus;

  @IsString()
  @IsOptional()
  error?: string;
}
