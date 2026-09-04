import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateAgentMemoryDto {
  @Matches(/^[a-z0-9_.-]+$/)
  @MaxLength(120)
  preferenceKey!: string;

  @IsObject()
  value!: Record<string, unknown>;

  @IsString()
  @MaxLength(120)
  source!: string;

  @IsString()
  @MaxLength(240)
  purpose!: string;

  @IsString()
  @MaxLength(160)
  consentId!: string;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
