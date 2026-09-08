import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';

export class CompleteProvisioningDto {
  @Transform(({ value, obj }) => value ?? obj.bind_token)
  @IsString()
  bindToken!: string;

  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsOptional()
  @IsString()
  deviceId?: string;
}
