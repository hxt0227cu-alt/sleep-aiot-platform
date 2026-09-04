import { PartialType } from '@nestjs/mapped-types';
import { CreateSleepDiaryDto } from './create-sleep-diary.dto';

export class UpdateSleepDiaryDto extends PartialType(CreateSleepDiaryDto) {}
