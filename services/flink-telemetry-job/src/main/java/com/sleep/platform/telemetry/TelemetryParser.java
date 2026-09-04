package com.sleep.platform.telemetry;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Set;
import java.util.UUID;

public final class TelemetryParser {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Set<String> SLEEP_STATES = Set.of("awake", "light", "deep", "rem", "unknown");

  private TelemetryParser() {}

  public static TelemetryEvent parse(String json) throws ValidationException {
    try {
      JsonNode node = MAPPER.readTree(json);
      require(node.isObject(), "payload must be a JSON object");
      require("device.telemetry.received".equals(text(node, "eventType")), "eventType is invalid");
      TelemetryEvent event = new TelemetryEvent();
      event.eventType = "device.telemetry.received";
      event.eventId = uuid(node, "eventId");
      event.traceId = uuid(node, "traceId");
      event.schemaVersion = integer(node, "schemaVersion");
      require(event.schemaVersion == 1, "schemaVersion must equal 1");
      event.tenantId = boundedText(node, "tenantId", 128);
      event.deviceId = boundedText(node, "deviceId", 128);
      event.occurredAtMs = instant(node, "occurredAt");
      event.receivedAtMs = instant(node, "receivedAt");
      event.sequence = optionalLong(node, "sequence", 0L);
      event.heartRate = optionalInteger(node, "heartRate", 20, 240);
      event.breathingRate = optionalInteger(node, "breathingRate", 2, 80);
      event.bodyMovement = optionalDouble(node, "bodyMovement", 0D, null);
      event.sleepState = optionalText(node, "sleepState", "unknown");
      require(SLEEP_STATES.contains(event.sleepState), "sleepState is invalid");
      event.confidence = optionalDouble(node, "confidence", 0D, 1D);
      return event;
    } catch (ValidationException error) {
      throw error;
    } catch (Exception error) {
      throw new ValidationException("payload is not valid JSON: " + error.getMessage());
    }
  }

  private static String uuid(JsonNode node, String name) throws ValidationException {
    String value = text(node, name);
    try {
      UUID.fromString(value);
      return value;
    } catch (IllegalArgumentException error) {
      throw new ValidationException(name + " must be a UUID");
    }
  }

  private static long instant(JsonNode node, String name) throws ValidationException {
    try {
      return Instant.parse(text(node, name)).toEpochMilli();
    } catch (DateTimeParseException error) {
      throw new ValidationException(name + " must be ISO-8601 UTC time");
    }
  }

  private static String boundedText(JsonNode node, String name, int maxLength) throws ValidationException {
    String value = text(node, name);
    require(!value.isBlank() && value.length() <= maxLength, name + " length is invalid");
    return value;
  }

  private static String text(JsonNode node, String name) throws ValidationException {
    JsonNode value = node.get(name);
    require(value != null && value.isTextual(), name + " must be a string");
    return value.textValue();
  }

  private static String optionalText(JsonNode node, String name, String fallback) throws ValidationException {
    JsonNode value = node.get(name);
    if (value == null || value.isNull()) return fallback;
    require(value.isTextual(), name + " must be a string");
    return value.textValue();
  }

  private static int integer(JsonNode node, String name) throws ValidationException {
    JsonNode value = node.get(name);
    require(value != null && value.isIntegralNumber(), name + " must be an integer");
    return value.intValue();
  }

  private static long optionalLong(JsonNode node, String name, long fallback) throws ValidationException {
    JsonNode value = node.get(name);
    if (value == null || value.isNull()) return fallback;
    require(value.isIntegralNumber() && value.longValue() >= 0, name + " must be a non-negative integer");
    return value.longValue();
  }

  private static Integer optionalInteger(JsonNode node, String name, int minimum, int maximum)
      throws ValidationException {
    JsonNode value = node.get(name);
    if (value == null || value.isNull()) return null;
    require(value.isIntegralNumber(), name + " must be an integer");
    int number = value.intValue();
    require(number >= minimum && number <= maximum, name + " is outside its allowed range");
    return number;
  }

  private static Double optionalDouble(JsonNode node, String name, Double minimum, Double maximum)
      throws ValidationException {
    JsonNode value = node.get(name);
    if (value == null || value.isNull()) return null;
    require(value.isNumber(), name + " must be numeric");
    double number = value.doubleValue();
    require(Double.isFinite(number), name + " must be finite");
    if (minimum != null) require(number >= minimum, name + " is below its allowed range");
    if (maximum != null) require(number <= maximum, name + " is above its allowed range");
    return number;
  }

  private static void require(boolean condition, String message) throws ValidationException {
    if (!condition) throw new ValidationException(message);
  }

  public static final class ValidationException extends Exception {
    public ValidationException(String message) {
      super(message);
    }
  }
}
