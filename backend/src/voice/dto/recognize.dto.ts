import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class RecognizeDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value, obj }) => value ?? obj.device_id)
  deviceId: string;

  @IsString()
  @IsOptional()
  @Transform(({ value, obj }) => value ?? obj.audio_data)
  audioData?: string;

  @IsString()
  @IsOptional()
  @Transform(({ value, obj }) => value ?? obj.audio_url)
  audioUrl?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  format?: string;

  @IsNumber()
  @IsOptional()
  @Transform(({ value, obj }) => value ?? obj.sample_rate)
  sampleRate?: number;

  @IsString()
  @IsOptional()
  @Transform(({ value, obj }) => value ?? obj.recognition_mode)
  recognitionMode?: string;
}
