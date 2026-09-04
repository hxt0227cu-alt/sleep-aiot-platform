package com.sleep.platform.telemetry;

import java.io.Serializable;

public class TelemetryEvent implements Serializable {
  public String eventType;
  public String eventId;
  public String traceId;
  public int schemaVersion;
  public String tenantId;
  public String deviceId;
  public long occurredAtMs;
  public long receivedAtMs;
  public long sequence;
  public Integer heartRate;
  public Integer breathingRate;
  public Double bodyMovement;
  public String sleepState;
  public Double confidence;

  public TelemetryEvent() {}
}
