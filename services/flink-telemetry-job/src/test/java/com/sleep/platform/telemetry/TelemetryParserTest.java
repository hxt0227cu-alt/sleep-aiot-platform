package com.sleep.platform.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TelemetryParserTest {
  private static final String VALID = """
      {
        "eventType":"device.telemetry.received",
        "eventId":"019c0000-0000-7000-8000-000000000001",
        "traceId":"019c0000-0000-7000-8000-000000000001",
        "schemaVersion":1,
        "tenantId":"tenant-flink-test",
        "deviceId":"device-flink-test",
        "occurredAt":"2026-07-30T00:00:15.000Z",
        "receivedAt":"2026-07-30T00:00:16.000Z",
        "sequence":1,
        "heartRate":62,
        "breathingRate":14,
        "bodyMovement":0.2,
        "sleepState":"deep",
        "confidence":0.94
      }
      """;

  @Test
  void parsesValidatedCanonicalTelemetry() throws Exception {
    TelemetryEvent event = TelemetryParser.parse(VALID);
    assertEquals("tenant-flink-test", event.tenantId);
    assertEquals(1785369615000L, event.occurredAtMs);
    assertEquals(62, event.heartRate);
  }

  @Test
  void rejectsOutOfRangeMeasurements() {
    TelemetryParser.ValidationException error = assertThrows(
        TelemetryParser.ValidationException.class,
        () -> TelemetryParser.parse(VALID.replace("\"heartRate\":62", "\"heartRate\":999")));
    assertTrue(error.getMessage().contains("heartRate"));
  }

  @Test
  void classifiesWatermarkBoundaryAsLate() {
    assertTrue(TelemetryStreamingJob.isLate(10_000L, 10_000L));
    assertTrue(!TelemetryStreamingJob.isLate(10_001L, 10_000L));
    assertTrue(!TelemetryStreamingJob.isLate(10_000L, Long.MIN_VALUE));
  }
}
