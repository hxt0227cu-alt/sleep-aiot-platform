import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class WechatLoginDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsOptional()
  encryptedData?: string;

  @IsString()
  @IsOptional()
  iv?: string;
}
