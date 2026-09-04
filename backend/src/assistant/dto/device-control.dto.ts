import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DeviceControlDto {
  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsNotEmpty()
  text: string;

  @IsString()
  @IsOptional()
  @IsIn(['voice', 'text'])
  source?: 'voice' | 'text';
}
