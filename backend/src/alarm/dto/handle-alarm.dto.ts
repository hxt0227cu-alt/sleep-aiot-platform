import { IsString, IsOptional } from 'class-validator';

export class HandleAlarmDto {
  @IsString()
  @IsOptional()
  note?: string;
}
