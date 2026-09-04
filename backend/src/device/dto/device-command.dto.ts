import { Transform, Type } from 'class-transformer';
import { IsEnum, IsOptional, IsObject, IsNumber } from 'class-validator';

export enum CommandType {
  LIGHT_CONTROL = 'light_control',
  AUDIO_CONTROL = 'audio_control',
  ANION_CONTROL = 'anion_control',
  VOICE_CONTROL = 'voice_control',
  ALARM_CONFIG = 'alarm_config',
  OTA_UPGRADE = 'ota_upgrade',
}

export class DeviceCommandDto {
  @IsEnum(CommandType)
  command: CommandType;

  @IsObject()
  params: Record<string, any>;

  @Transform(({ value }) =>
    value === undefined || value === null ? value : Number(value),
  )
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  timeout?: number;
}
