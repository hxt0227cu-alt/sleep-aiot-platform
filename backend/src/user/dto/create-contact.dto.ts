import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateContactDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 50)
  @Matches(/^[\u4e00-\u9fa5a-zA-Z\s]+$/u, {
    message: 'Name can only contain Chinese characters, letters, and spaces',
  })
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^1[3-9]\d{9}$/, { message: 'Invalid phone number format' })
  phone!: string;

  @IsString()
  @IsOptional()
  @Length(1, 20)
  relationship?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(10)
  priority?: number;
}
