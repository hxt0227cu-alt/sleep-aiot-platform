import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';

export enum DeviceType {
  SLEEP_LAMP = 'sleep_lamp',
}

export class RegisterDeviceDto {
  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @Transform(({ value, obj }) => value ?? obj.device_name)
  @IsString()
  @IsNotEmpty()
  deviceName: string;

  @Transform(({ value, obj }) => value ?? obj.device_type)
  @IsEnum(DeviceType)
  @IsOptional()
  deviceType?: DeviceType;

  @Transform(({ value, obj }) => value ?? obj.firmware_version)
  @IsString()
  @IsOptional()
  firmwareVersion?: string;

  @Transform(({ value, obj }) => value ?? obj.mac_address)
  @IsString()
  @IsOptional()
  macAddress?: string;

  @Transform(({ value, obj }) => value ?? obj.chip_id)
  @IsString()
  @IsOptional()
  chipId?: string;

  @Transform(({ value, obj }) => value ?? obj.psram_size)
  @IsString()
  @IsOptional()
  psramSize?: string;
}
