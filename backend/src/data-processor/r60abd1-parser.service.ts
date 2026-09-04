import { Injectable, Logger } from '@nestjs/common';

export interface R60ABD1Data {
  deviceId: string;
  timestamp: number;
  heartRate?: number;
  breathingRate?: number;
  bodyMovement?: number;
  sleepState?: string;
  sleepScore?: number;
  confidence?: number;
  presence?: boolean;
  distance?: number;
  rawData?: any;
}

@Injectable()
export class R60ABD1ParserService {
  private readonly logger = new Logger(R60ABD1ParserService.name);

  parseR60ABD1Data(deviceId: string, rawData: any): R60ABD1Data {
    try {
      const source = this.flattenRawData(rawData);
      const timestamp = this.normalizeTimestamp(
        source.timestamp ?? rawData.timestamp,
      );

      const parsedData: R60ABD1Data = {
        deviceId,
        timestamp,
        heartRate: this.extractHeartRate(source),
        breathingRate: this.extractBreathingRate(source),
        bodyMovement: this.extractBodyMovement(source),
        sleepState: this.extractSleepState(source),
        sleepScore: this.extractSleepScore(source),
        confidence: this.extractConfidence(source),
        presence: this.extractPresence(source),
        distance: this.extractDistance(source),
        rawData,
      };

      this.logger.debug(`Parsed R60ABD1 data for device ${deviceId}`);
      return parsedData;
    } catch (error) {
      this.logger.error(
        `Error parsing R60ABD1 data for device ${deviceId}:`,
        error,
      );
      throw error;
    }
  }

  validateR60ABD1Data(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const source = this.flattenRawData(data);
    const heartRate = this.extractHeartRate(source);
    const breathingRate = this.extractBreathingRate(source);
    const bodyMovement = this.extractBodyMovement(source);
    const hasValidTimestamp =
      source.timestamp === undefined || !isNaN(Number(source.timestamp));
    const hasValidHeartRate =
      heartRate === undefined ||
      (Number.isFinite(heartRate) && heartRate >= 0 && heartRate <= 200);
    const hasValidBreathingRate =
      breathingRate === undefined ||
      (Number.isFinite(breathingRate) &&
        breathingRate >= 0 &&
        breathingRate <= 60);
    const hasValidBodyMovement =
      bodyMovement === undefined ||
      (Number.isFinite(bodyMovement) &&
        bodyMovement >= 0 &&
        bodyMovement <= 100);

    return (
      hasValidTimestamp &&
      hasValidHeartRate &&
      hasValidBreathingRate &&
      hasValidBodyMovement
    );
  }

  private flattenRawData(rawData: any): any {
    const data =
      rawData?.data && typeof rawData.data === 'object' ? rawData.data : {};
    const realtime =
      rawData?.realtime && typeof rawData.realtime === 'object'
        ? rawData.realtime
        : {};
    const nestedRealtime =
      data?.realtime && typeof data.realtime === 'object' ? data.realtime : {};
    return {
      ...nestedRealtime,
      ...realtime,
      ...data,
      ...rawData,
    };
  }

  private normalizeTimestamp(timestamp: any): number {
    const value = Number(timestamp);
    const minReasonableEpochMs = 946684800000; // 2000-01-01

    if (Number.isFinite(value) && value >= minReasonableEpochMs) {
      return value;
    }

    return Date.now();
  }

  private extractHeartRate(rawData: any): number | undefined {
    if (rawData.heartRate !== undefined) {
      return Number(rawData.heartRate);
    }
    if (rawData.hr !== undefined) {
      return Number(rawData.hr);
    }
    if (rawData.heart_rate !== undefined) {
      return Number(rawData.heart_rate);
    }
    return undefined;
  }

  private extractBreathingRate(rawData: any): number | undefined {
    if (rawData.breathingRate !== undefined) {
      return Number(rawData.breathingRate);
    }
    if (rawData.br !== undefined) {
      return Number(rawData.br);
    }
    if (rawData.breathing_rate !== undefined) {
      return Number(rawData.breathing_rate);
    }
    return undefined;
  }

  private extractBodyMovement(rawData: any): number | undefined {
    if (rawData.bodyMovement !== undefined) {
      return Number(rawData.bodyMovement);
    }
    if (rawData.movement !== undefined) {
      return Number(rawData.movement);
    }
    if (rawData.body_movement !== undefined) {
      return Number(rawData.body_movement);
    }
    if (rawData.movement_level !== undefined) {
      return Number(rawData.movement_level);
    }
    return undefined;
  }

  private extractSleepState(rawData: any): string | undefined {
    if (rawData.sleepState !== undefined) {
      return String(rawData.sleepState);
    }
    if (rawData.state !== undefined) {
      return String(rawData.state);
    }
    if (rawData.sleep_state !== undefined) {
      return String(rawData.sleep_state);
    }
    return undefined;
  }

  private extractSleepScore(rawData: any): number | undefined {
    if (rawData.sleepScore !== undefined) {
      return Number(rawData.sleepScore);
    }
    if (rawData.score !== undefined) {
      return Number(rawData.score);
    }
    if (rawData.sleep_score !== undefined) {
      return Number(rawData.sleep_score);
    }
    return undefined;
  }

  private extractConfidence(rawData: any): number | undefined {
    if (rawData.confidence !== undefined) {
      return Number(rawData.confidence);
    }
    if (rawData.conf !== undefined) {
      return Number(rawData.conf);
    }
    return undefined;
  }

  private extractPresence(rawData: any): boolean | undefined {
    if (rawData.presence !== undefined) {
      if (typeof rawData.presence === 'string') {
        return (
          rawData.presence === '1' || rawData.presence.toLowerCase() === 'true'
        );
      }
      return Boolean(rawData.presence);
    }
    if (rawData.is_present !== undefined) {
      return Boolean(rawData.is_present);
    }
    return undefined;
  }

  private extractDistance(rawData: any): number | undefined {
    if (rawData.distance !== undefined) {
      return Number(rawData.distance);
    }
    if (rawData.dist !== undefined) {
      return Number(rawData.dist);
    }
    if (rawData.distance_cm !== undefined) {
      return Number(rawData.distance_cm);
    }
    return undefined;
  }

  normalizeSleepState(sleepState: string): string {
    const stateMap: { [key: string]: string } = {
      awake: 'awake',
      light: 'light_sleep',
      deep: 'deep_sleep',
      rem: 'rem_sleep',
      light_sleep: 'light_sleep',
      deep_sleep: 'deep_sleep',
      rem_sleep: 'rem_sleep',
      '0': 'deep_sleep',
      '1': 'light_sleep',
      '2': 'awake',
      '3': 'unknown',
    };

    return stateMap[sleepState.toLowerCase()] || 'unknown';
  }

  calculateSleepQuality(
    heartRate: number,
    breathingRate: number,
    bodyMovement: number,
  ): number {
    let score = 100;

    if (heartRate > 100) {
      score -= (heartRate - 100) * 0.5;
    } else if (heartRate < 50) {
      score -= (50 - heartRate) * 0.5;
    }

    if (breathingRate > 25) {
      score -= (breathingRate - 25) * 1;
    } else if (breathingRate < 12) {
      score -= (12 - breathingRate) * 1;
    }

    if (bodyMovement > 50) {
      score -= (bodyMovement - 50) * 0.3;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }
}
