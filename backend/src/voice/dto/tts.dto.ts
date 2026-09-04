import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class TtsDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsString()
  @IsOptional()
  voice?: string;

  @IsNumber()
  @IsOptional()
  speed?: number;

  @IsString()
  @IsOptional()
  language?: string;

  @IsNumber()
  @IsOptional()
  pitch?: number;

  @IsNumber()
  @IsOptional()
  volume?: number;

  @IsString()
  @IsOptional()
  format?: string;
}
