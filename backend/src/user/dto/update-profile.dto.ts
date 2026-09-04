import {
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @Length(2, 50)
  @Matches(/^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/u, {
    message:
      'Nickname can only contain Chinese characters, letters, numbers, underscores, and hyphens',
  })
  nickname?: string;

  @IsUrl({
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  @IsOptional()
  @MaxLength(500)
  avatarUrl?: string;
}
