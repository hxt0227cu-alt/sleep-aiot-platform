import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(17)
  macAddress?: string;

  @IsString()
  @IsOptional()
  location?: string;
}
