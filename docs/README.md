# Documentation

This repository is a reference implementation of a smart sleep-monitoring IoT platform. Start with the [README](../README.md), then dig in:

## Platform & product

- [Architecture overview](architecture.md) — system design, modules, data flows (Chinese).
- [Product requirements](product-requirements.md) — PRD (Chinese).
- [User manual](user-manual.md)

## Engineering decisions

- [Architecture decision records](architecture-decisions/) — 22 ADRs covering service boundaries, control/data plane separation, reliable ingestion, DLQ, schema governance, multi-tenant enforcement, connection governance, observability, and more.

## Backend

- [API design](../backend/docs/API_Design.md)
- [Database design](../backend/docs/Database_Design.md)
- [MQTT protocol](../backend/docs/MQTT_Protocol.md)
- [Contract baseline](../backend/docs/CONTRACT_BASELINE.md)

## Hardware

- [Radar protocol (R60ABD1)](hardware/r60abd1-protocol.md)
- [GSM module (SIM800C)](hardware/sim800c-gsm.md)
- [Audio amplifier (MAX98357)](hardware/max98357-audio.md)
- [Microphone (ICS-43434)](hardware/ics-43434-microphone.md)

## Sleep domain

- [Sleep tech basis](sleep-domain/sleep-tech-basis.md)
- [Sleep health guide](sleep-domain/sleep-health-guide.md)
- [Alarm safety guide](sleep-domain/alarm-safety-guide.md)

## Operations

- [Deployment](deployment.md)
- [Development guide](development.md)
