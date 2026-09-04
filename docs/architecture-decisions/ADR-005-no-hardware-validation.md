# ADR-005: Software-only delivery without physical hardware

Date: 2026-07-24

## Status

Accepted.

## Context

No physical sleep-lamp device is available during the current project phase. The project is intended for interview demonstration and technical discussion, where the device will not be present.

## Decision

- Stop opening active tasks for firmware compilation, flashing, board bring-up, sensor calibration, touch thresholds, PWM polarity, microphone accuracy, or physical audio quality.
- Retain firmware as source and architecture evidence, without claiming physical validation.
- Validate the software control and data planes with deterministic simulated devices.
- The simulator must cover telemetry, command acknowledgements, offline devices, timeouts, failures, retries, duplicate events, backlog, and recovery.
- Store the seed, configuration, raw results, environment, and source revision with each experiment.
- Label every simulated result as synthetic/simulated. Never describe it as physical-device or production evidence.

## Completion criteria

Software items are complete when they have automated tests and reproducible simulation evidence. Absence of physical hardware is not a blocker for software completion.

## Future hardware work

If hardware becomes available later, create a separate board-validation milestone. It must not reopen or invalidate completed software-only evidence unless an actual protocol incompatibility is found.
