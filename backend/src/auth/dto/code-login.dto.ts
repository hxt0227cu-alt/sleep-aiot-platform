import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CodeLoginDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: '验证码格式不正确' })
  code!: string;
}
