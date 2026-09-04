import { IsEnum, IsOptional, IsString } from 'class-validator';
import { AlarmStatus } from './create-alarm.dto';

export class UpdateAlarmDto {
  @IsEnum(AlarmStatus)
  @IsOptional()
  status?: AlarmStatus;

  @IsString()
  @IsOptional()
  note?: string;
}
