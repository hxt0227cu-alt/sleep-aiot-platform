import { Transform } from 'class-transformer';
import { IsString, IsNotEmpty } from 'class-validator';

export class BindDeviceDto {
  @Transform(({ value, obj }) => value ?? obj.device_id)
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @Transform(({ value, obj }) => value ?? obj.binding_code)
  @IsString()
  @IsNotEmpty()
  bindingCode: string;
}
