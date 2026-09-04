import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateAlgorithmProposalDto {
  @IsUUID()
  runId!: string;
}

export class TransitionAlgorithmProposalDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class RejectAlgorithmProposalDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class RollbackAlgorithmProposalDto extends RejectAlgorithmProposalDto {}
