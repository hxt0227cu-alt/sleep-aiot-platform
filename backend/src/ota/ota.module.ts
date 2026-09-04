import { Module } from '@nestjs/common';
import { OtaService } from './ota.service';
import { OtaController } from './ota.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [OtaController],
  providers: [OtaService],
})
export class OtaModule {}
