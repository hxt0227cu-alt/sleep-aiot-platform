import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AliyunIotBridgeService {
  private readonly logger = new Logger(AliyunIotBridgeService.name);

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    return (
      this.configService.get<string>('ALIYUN_IOT_BRIDGE_ENABLED') === 'true'
    );
  }

  async publishProperties(deviceId: string, properties: Record<string, any>) {
    if (!this.isEnabled()) {
      return { skipped: true, reason: 'ALIYUN_IOT_BRIDGE_ENABLED is not true' };
    }

    // The bridge intentionally keeps device firmware on the local MQTT protocol.
    // A later adapter can sign and publish these properties to Aliyun IoT.
    this.logger.log(`Aliyun IoT bridge queued properties for ${deviceId}`);
    return {
      skipped: false,
      deviceId,
      productKey: this.configService.get<string>('ALIYUN_IOT_PRODUCT_KEY'),
      properties,
    };
  }
}
