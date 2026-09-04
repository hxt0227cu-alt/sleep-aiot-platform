import { Module } from '@nestjs/common';
import { DataProcessorService } from './data-processor.service';
import { R60ABD1ParserService } from './r60abd1-parser.service';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { AlarmModule } from '../alarm/alarm.module';

@Module({
  imports: [DatabaseModule, RedisModule, WebSocketModule, AlarmModule],
  providers: [DataProcessorService, R60ABD1ParserService],
  exports: [DataProcessorService, R60ABD1ParserService],
})
export class DataProcessorModule {}
