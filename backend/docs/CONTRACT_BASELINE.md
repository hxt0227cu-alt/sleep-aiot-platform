# Backend Contract Baseline

Last updated: 2026-05-27

This document freezes the backend contract baseline for the current repo state.
It is the working source of truth for:

- HTTP API paths and request/response shapes
- Prisma model boundaries and ownership
- MQTT topics and payload compatibility expectations
- WebSocket event names and envelope shape

The baseline is compatibility-first. Do not rename existing API paths, MQTT topics,
WebSocket `type` names, or Prisma model identifiers without an explicit migration
decision across backend, device firmware, and frontend bridge layers.

## 1. Freeze Rules

- Existing HTTP paths are stable. Prefer additive changes over renames.
- Existing MQTT topics are stable. Prefer new fields or new sub-topics over topic replacement.
- Existing WebSocket `type` names are stable. Do not introduce aliases unless both old and new remain supported.
- Device-facing payloads must remain backward compatible with the current frontend bridge and firmware.
- Where the current backend returns both `camelCase` and `snake_case`, both forms remain part of the live contract.
- Status values are currently string conventions in Prisma, not DB enums. Treat them as contract values.

## 2. Module Baseline

Current root module wiring in `backend/src/app.module.ts`:

- `DatabaseModule`
- `RedisModule`
- `MqttModule`
- `AuthModule`
- `DeviceModule`
- `SleepModule`
- `AlarmModule`
- `UserModule`
- `OtaModule`
- `VoiceModule`
- `WebSocketModule`
- `DashboardModule`
- `AssistantModule`
- `ObservabilityModule`
- `TenantModule`
- `AgentRunModule`
- `IntegrationModule`
- `AlgorithmProposalModule`

Integration consequence:

- Device state is cross-cutting across Prisma, Redis, MQTT, and WebSocket.
- Contract changes in device, sleep, auth, MQTT, or WebSocket must be reviewed together.

## 3. HTTP API Baseline

All routes below are currently active and should be treated as frozen names.

### 3.1 Auth

Controller: `backend/src/auth/auth.controller.ts`

Base path: `/auth`

- `POST /auth/register`
  - Body:
    - `phone: string`
    - `password: string`
    - `nickname?: string`
    - `code: string`
    - `wechatOpenid?: string`
  - Validation:
    - phone must match `^1[3-9]\d{9}$`
  - Behavior:
    - verification code is required in current service logic
  - Response:
    - `user`
    - `accessToken`
    - `refreshToken`
    - `expiresIn`

- `POST /auth/login`
  - Body:
    - `phone: string`
    - `password: string`
  - Response:
    - `user`
    - `accessToken`
    - `refreshToken`
    - `expiresIn`

- `POST /auth/code-login`
  - Body:
    - `phone: string`
    - `code: string`
  - Behavior:
    - auto-registers user if phone does not exist
  - Response:
    - `user`
    - `accessToken`
    - `refreshToken`
    - `expiresIn`

- `POST /auth/wechat-login`
  - Body:
    - `code: string`
    - `encryptedData?: string`
    - `iv?: string`
  - Response:
    - `user`
    - `accessToken`
    - `refreshToken`
    - `expiresIn`

- `POST /auth/refresh`
  - Body:
    - `refreshToken?: string`
  - Behavior:
    - accepts refresh token either in body or as `Authorization: Bearer <refreshToken>`
  - Response:
    - `accessToken`
    - `refreshToken`
    - `expiresIn`

- `POST /auth/logout`
  - Auth:
    - no route guard is applied
  - Behavior:
    - accepts optional `Authorization: Bearer <accessToken>`
    - accepts optional body `refreshToken`
    - revokes the resolved session or all sessions for the resolved user on a best-effort basis
  - Response:
    - `message`

- `POST /auth/send-code`
  - Body:
    - `phone: string`
    - `type: 'register' | 'login' | 'reset_password'`
  - Response:
    - `message`
    - `expiresIn`
    - `code` in non-production only

- `POST /auth/reset-password`
  - Body:
    - `phone: string`
    - `code: string`
    - `newPassword: string`
  - Response:
    - `message`
    - `user`

- `GET /auth/me`
  - Auth:
    - Bearer JWT required
  - Response:
    - `id`
    - `phone`
    - `nickname`
    - `avatarUrl`
    - `lastLoginAt`
    - `createdAt`

### 3.2 Devices

Controllers:

- `backend/src/device/device-registration.controller.ts`
- `backend/src/device/device.controller.ts`

Base path: `/devices`

Important current-state note:

- `POST /devices/register` lives in `DeviceRegistrationController` and is currently anonymous.
- `DeviceController` is guarded at class level with `JwtAuthGuard`.
- Therefore `/devices/register` is anonymously open, while the rest of the routes below remain JWT-protected unless stated otherwise.

- `POST /devices/register`
  - Auth:
    - anonymous
  - Body:
    - `deviceId: string`
    - `deviceName: string`
    - `deviceType?: 'sleep_lamp'`
    - `firmwareVersion?: string`
    - `macAddress?: string`
    - `chipId?: string`
    - `psramSize?: string`
  - Response:
    - `deviceId`
    - `device_id`
    - `bindingCode`
    - `binding_code`
    - `expiresIn`
    - `expires_in`
    - `mqttConfig`
      - `broker`
      - `port`
      - `username`
      - `password`
    - `mqtt_config`
      - `broker`
      - `port`
      - `username`
      - `password`

- `POST /devices/provisioning-token`
  - Auth:
    - Bearer JWT required
  - Response:
    - `bindToken`
    - `bind_token`
    - `expiresIn`
    - `expires_in`

- `POST /devices/provisioning-complete`
  - Auth:
    - Bearer JWT required
  - Body accepts both:
    - `bindToken` or `bind_token`
    - `deviceId` or `device_id`
  - Response includes both:
    - `deviceId`
    - `device_id`
    - `deviceName`
    - `device_name`
    - `bindingStatus`
    - `binding_status`
    - `message`

- `POST /devices/bind`
  - Auth:
    - Bearer JWT required
  - Body:
    - `deviceId: string`
    - `bindingCode: string`
  - Response:
    - `message`
    - `deviceId`
    - `device_id`
    - `deviceName`
    - `device_name`
    - `bindingStatus`
    - `binding_status`

- `DELETE /devices/:deviceId/unbind`
  - Auth:
    - Bearer JWT required
  - Response:
    - `message`
    - `deviceId`
    - `device_id`

- `GET /devices`
  - Auth:
    - Bearer JWT required
  - Response:
    - array of device objects
  - Device object currently includes:
    - `deviceId`
    - `device_id`
    - `deviceName`
    - `device_name`
    - `deviceType`
    - `device_type`
    - `online`
    - `lastSeen`
    - `last_seen`
    - `firmwareVersion`
    - `firmware_version`
    - `location`
    - `role`
    - `bindingStatus`
    - `binding_status`
    - `boundAt`
    - `bound_at`
    - `light`
    - `light_state`
    - `status`
      - currently a nested summary object, not just a string
      - includes `online`, `last_seen`, `firmware_version`, optional `light`, and `light_alarms`

- `GET /devices/:deviceId`
  - Auth:
    - Bearer JWT required
  - Response:
    - all list fields, plus:
    - `hardwareInfo`
      - `chipId`
      - `macAddress`
      - `psramSize`
    - `hardware_info`
      - `chip_id`
      - `mac_address`
      - `psram_size`
    - `bindingStatus`
    - `binding_status`
    - `boundAt`
    - `bound_at`
    - `status`
      - current nested summary object
      - includes `online`, `last_seen`, `firmware_version`, optional `light`, and `light_alarms`
    - `config`

- `POST /devices/:deviceId/command`
  - Auth:
    - Bearer JWT required
  - Body:
    - `command: 'light_control' | 'audio_control' | 'anion_control' | 'voice_control' | 'alarm_config' | 'ota_upgrade'`
    - `params: Record<string, any>`
    - `timeout?: number`
  - Response:
    - `commandId`
    - `command_id`
    - `status`
    - `result`

- `POST /devices/create`
  - Auth:
    - Bearer JWT required
  - Body:
    - `name: string`
    - `macAddress?: string`
    - `location?: string`
  - Response:
    - `deviceId`
    - `device_id`
    - `deviceName`
    - `device_name`
    - `macAddress`
    - `mac_address`
    - `location`
    - `status`
    - `createdAt`
    - `created_at`

- `PUT /devices/:deviceId`
  - Auth:
    - Bearer JWT required
  - Body:
    - `name?: string`
    - `location?: string`
  - Response:
    - `deviceId`
    - `device_id`
    - `deviceName`
    - `device_name`
    - `location`
    - `updatedAt`
    - `updated_at`

- `DELETE /devices/:deviceId`
  - Auth:
    - Bearer JWT required
  - Response:
    - `message`
    - `deviceId`
    - `device_id`

- `GET /devices/:deviceId/status`
  - Auth:
    - Bearer JWT required
  - Response:
    - `deviceId`
    - `device_id`
    - `online`
    - `lastSeen`
    - `last_seen`
    - `status`
    - `firmwareVersion`
    - `firmware_version`
    - `light`
    - `light_state`
    - `light_alarms`

- `POST /devices/batch-status`
  - Auth:
    - Bearer JWT required
  - Body:
    - `deviceIds: string[]`
  - Constraints:
    - must be array
    - must not be empty
    - max 100 device ids
  - Response:
    - array of:
      - `deviceId`
      - `device_id`
      - `online`
      - `lastSeen`
      - `last_seen`
      - `status`

- `PUT /devices/:deviceId/config`
  - Auth:
    - Bearer JWT required
  - Body:
    - `config: Record<string, any>`
  - Response:
    - `message`
    - `deviceId`
    - `device_id`
    - `config`

- `GET /devices/:deviceId/config`
  - Auth:
    - Bearer JWT required
  - Response:
    - `deviceId`
    - `device_id`
    - `light`
    - `light_state`
    - `config`

- `POST /devices/:deviceId/refresh-binding-code`
  - Auth:
    - Bearer JWT required
  - Response:
    - `deviceId`
    - `device_id`
    - `bindingCode`
    - `binding_code`
    - `expiry`
    - `expiresIn`
    - `expires_in`

- `GET /devices/stats/summary`
  - Auth:
    - Bearer JWT required
  - Response:
    - `totalDevices`
    - `total_devices`
    - `onlineCount`
    - `online_count`
    - `offlineCount`
    - `offline_count`
    - `onlineRate`
    - `online_rate`
  - Important current-state note:
    - `onlineRate` and `online_rate` are currently formatted strings such as `"66.67"`, not numbers.

### 3.3 Sleep

Controller: `backend/src/sleep/sleep.controller.ts`

Base path: `/sleep`

All routes are JWT-protected.

- `GET /sleep/plan`
  - Response:
    - `bedTime`
    - `sleepDuration`
    - `wakeTime`
    - `reminderEnabled`
    - `updatedAt`

- `PUT /sleep/plan`
  - Body:
    - `bedTime: 'HH:mm'`
    - `sleepDuration: number`
    - `wakeTime: 'HH:mm'`
    - `reminderEnabled: boolean`
  - Response:
    - same shape as `GET /sleep/plan`

- `GET /sleep/routine-template`
  - Response:
    - `steps`
    - `updatedAt`

- `PUT /sleep/routine-template`
  - Body:
    - `steps: Array<{ id, name, sortOrder, isFixed, enabled }>`
  - Response:
    - `steps`
    - `updatedAt`

- `POST /sleep/routine-records`
  - Body:
    - `date: ISO date string`
    - `startedAt: ISO date string`
    - `completedAt?: ISO date string`
    - `stepsSnapshot: Array<{ id, name, sortOrder, isFixed, enabled }>`
    - `finished: boolean`
  - Response:
    - `id`
    - `date`
    - `startedAt`
    - `completedAt`
    - `stepsSnapshot`
    - `finished`
    - `createdAt`
    - `updatedAt`

- `GET /sleep/routine-records`
  - Query:
    - `limit?: number`
  - Response:
    - array of routine record objects

- `GET /sleep/diaries`
  - Query:
    - `limit?: number`
  - Response:
    - array of diary objects

- `POST /sleep/diaries`
  - Body:
    - `deviceId?: string`
    - `date: 'YYYY-MM-DD'`
    - `bedTime: 'HH:mm'`
    - `wakeTime: 'HH:mm'`
    - `fallAsleepMinutes: number`
    - `quality: 'excellent' | 'good' | 'poor'`
    - `summary: string`
  - Response:
    - `id`
    - `userId`
    - `deviceId`
    - `date`
    - `bedTime`
    - `wakeTime`
    - `fallAsleepMinutes`
    - `quality`
    - `summary`
    - `createdAt`
    - `updatedAt`

- `GET /sleep/diaries/:diaryId`
  - Response:
    - same shape as create diary response

- `PUT /sleep/diaries/:diaryId`
  - Body:
    - partial diary fields
  - Response:
    - same shape as create diary response

- `POST /sleep/relax-records`
  - Body:
    - `methodId: 'breathing' | 'muscle' | 'meditation'`
    - `methodName: string`
    - `durationSeconds: number`
    - `completedAt?: ISO date string`
    - `status?: string`
  - Response:
    - `id`
    - `methodId`
    - `methodName`
    - `durationSeconds`
    - `completedAt`
    - `status`
    - `createdAt`

- `GET /sleep/relax-records`
  - Query:
    - `limit?: number`
  - Response:
    - array of relax record objects

- `GET /sleep/:deviceId/realtime`
  - Response:
    - `deviceId`
    - `timestamp`
    - `heartRate`
      - `value`
      - `unit`
      - `status`
    - `breathingRate`
      - `value`
      - `unit`
      - `status`
    - `bodyMovement`
      - `value`
      - `unit`
      - `status`
    - `sleepState`
      - `state`
      - `confidence`

- `GET /sleep/:deviceId/history`
  - Query:
    - `startTime: number`
    - `endTime: number`
    - `interval?: number`
    - `metrics?: string`
  - Response:
    - `deviceId`
    - `startTime`
    - `endTime`
    - `interval`
    - `metrics`
      - `heartRate?: Array<{ timestamp, value }>`
      - `breathingRate?: Array<{ timestamp, value }>`
      - `bodyMovement?: Array<{ timestamp, value }>`

- `GET /sleep/:deviceId/report`
  - Query:
    - `date?: string`
  - Response:
    - `deviceId`
    - `date`
    - `sleepScore`
    - `sleepDuration`
      - `total`
      - `deep`
      - `light`
      - `rem`
      - `awake`
    - `sleepEfficiency`
    - `sleepLatency`
    - `awakenings`
    - `sleepStructure`
    - `vitalSigns`
    - `healthSuggestions`

- `GET /sleep/:deviceId/trend`
  - Query:
    - `days?: number`
    - `metric?: string`
  - Response:
    - `deviceId`
    - `period`
    - `trend`
      - `sleepScore`
      - `sleepDuration`
      - `efficiency`

Important current-state note:

- `metric` is accepted in the DTO, but the service currently returns all three trend series regardless.
- Do not rely on `metric` filtering unless explicitly implemented later.

## 4. WebSocket Baseline

Gateway: `backend/src/websocket/websocket.gateway.ts`

Path:

- `/ws`

Connection query params:

- `token` is required
- `device_id` is optional

### 4.1 Client-to-server message names

The following incoming event names are active and frozen:

- `heartbeat`
- `ping`
- `subscribe`
- `unsubscribe`

`subscribe` currently accepts payload variants containing:

- `deviceId` or `device_id`
- `events` or `message_type` or `messageType`

Important current-state note:

- `events` is acknowledged and echoed back, but not used as a real server-side event filter.
- Current subscription routing is device-based, not event-type-based.

### 4.2 Server-to-client `type` names

The following outgoing `type` values are active and frozen:

- `connected`
- `heartbeat_ack`
- `pong`
- `subscribed`
- `unsubscribed`
- `device_status`
- `vital_signs`
- `light_state`
- `alarm`
- `command_response`
- `notification`
- `system`
- `ota_progress`
- `device_log`
- `sleep_report`

### 4.3 WebSocket envelope

Device-targeted broadcasts use:

```json
{
  "type": "device_status",
  "deviceId": "xxx",
  "device_id": "xxx",
  "data": {},
  "timestamp": 0
}
```

User-targeted broadcasts use:

```json
{
  "type": "notification",
  "data": {},
  "timestamp": 0
}
```

### 4.4 WebSocket payload shapes

Frozen payload shapes emitted by `WebSocketService`:

- `device_status`
  - `deviceId`
  - `device_id`
  - `online`
  - `status`
  - `lastSeen`
  - `last_seen`
  - `firmwareVersion?`
  - `firmware_version?`
  - `batteryLevel?`
  - `battery_level?`
  - `signalStrength?`
  - `signal_strength?`
  - `bindToken?`
  - `bind_token?`
  - `light?`
  - `light_state?`

- `vital_signs`
  - `deviceId`
  - `device_id`
  - `timestamp`
  - `heartRate?`
  - `heart_rate?`
    - object with `value`, `unit`, `status`
  - `breathingRate?`
  - `breathing_rate?`
    - object with `value`, `unit`, `status`
  - `bodyMovement?`
  - `body_movement?`
    - object with `value`, `unit`, `status`
  - `sleepState?`
  - `sleep_state?`
    - object with `state`, `confidence`
  - `sleepScore?`
  - `sleep_score?`
  - `confidence?`
  - `duration?`
  - `duration_seconds?`
  - `light?`
  - `light_state?`

- `light_state`
  - `deviceId`
  - `device_id`
  - `power`
  - `on`
  - `brightness`
  - `colorTemp`
  - `color_temp`
  - `source?`
  - `updatedAt`
  - `updated_at`

- `alarm`
  - `alarmId`
  - `deviceId`
  - `type`
  - `level`
  - `message`
  - `value?`
  - `threshold?`
  - `timestamp`
  - `status?`

- `command_response`
  - `commandId`
  - `command_id`
  - `deviceId`
  - `device_id`
  - `status`
  - `result?`
  - `error?`
  - `timestamp`

- `notification`
  - `userId`
  - `type`
  - `title`
  - `message`
  - `data?`
  - `timestamp`

- `ota_progress`
  - current payload includes:
    - `deviceId`
    - `device_id`
    - passthrough progress fields
    - `timestamp`

- `device_log`
  - current payload includes:
    - `deviceId`
    - `device_id`
    - log fields
    - `timestamp`

- `sleep_report`
  - current payload includes:
    - `deviceId`
    - `device_id`
    - `date`
    - `reportDate`
    - `report_date`
    - `sleepScore`
    - `sleep_score`
    - `sleepDuration`
    - `sleep_duration`
    - `sleepEfficiency`
    - `sleep_efficiency`
    - `sleepLatency`
    - `sleep_latency`
    - `awakenings`
    - `sleepStructure`
    - `sleep_structure`
    - `vitalSigns`
    - `vital_signs`
    - `healthSuggestions`
    - `health_suggestions`
    - `timestamp`

Important current-state note:

- Device-targeted WebSocket payloads preserve mixed `camelCase` and `snake_case` compatibility fields in the inner `data` object.
- The top-level envelope `timestamp` is the broadcast time; many inner payloads also carry their own domain timestamp fields.

## 5. MQTT Baseline

Primary sources:

- `backend/src/mqtt/mqtt.service.ts`
- `backend/src/mqtt/mqtt-router.service.ts`
- `backend/src/mqtt/interfaces/mqtt-message.interface.ts`
- `backend/src/mqtt/device-message-handler.service.ts`
- `backend/src/mqtt/cloud-message-publisher.service.ts`

### 5.1 Default subscribed topics

The backend currently subscribes to:

- `sleep/+/data`
- `sleep/+/state`
- `sleep/+/report`
- `device/+/status`
- `device/+/alarm`
- `device/+/log`
- `device/+/command`
- `device/+/command/response`
- `device/+/ota/command`
- `device/+/ota/progress`

Important current-state notes:

- `device/+/command` and `device/+/ota/command` are subscribed for compatibility and callback handling, but the default MQTT router does not dispatch them to `DeviceMessageHandlerService`.
- `device/+/telemetry` is not a backend subscription. It is published by devices and consumed by `services/telemetry-ingest` through `$share/telemetry-ingest/device/+/telemetry` under ADR-013 ownership.

### 5.2 Routed inbound topics

The router currently has default route rules for:

- `device/+/status`
- `device/+/alarm`
- `device/+/log`
- `device/+/command/response`
- `device/+/ota/progress`
- `sleep/+/data`
- `sleep/+/state`
- `sleep/+/report`

### 5.3 Outbound cloud-to-device topics

Current downlink topics are:

- `device/{deviceId}/config`
- `device/{deviceId}/command`
- `device/{deviceId}/notification`
- `device/{deviceId}/ota/command`

### 5.4 MQTT message type names

Current type names in `MqttMessageType`:

- `telemetry`
- `status`
- `alarm`
- `log`
- `command`
- `command/response`
- `ota/progress`
- `ota/command`
- `data`
- `state`
- `report`
- `config`
- `notification`

Do not rename these string values casually. They are protocol contract values.

### 5.5 Payload compatibility rule for `device/{deviceId}/command`

This topic currently has two live payload patterns in the codebase and must remain backward compatible with both.

Pattern A: direct command payload from `DeviceService.sendCommand`

```json
{
  "messageId": "cmd_xxx",
  "commandId": "cmd_xxx",
  "type": "command",
  "command": "light_control",
  "params": {},
  "timestamp": 0,
  "deviceId": "xxx",
  "userId": "xxx"
}
```

Pattern B: wrapped cloud command payload from `CloudMessagePublisherService.sendCommandToDevice`

```json
{
  "messageId": "cmd_xxx",
  "timestamp": 0,
  "deviceId": "xxx",
  "type": "command",
  "priority": 2,
  "data": {
    "commandId": "cmd_xxx",
    "command": "light_control",
    "params": {}
  }
}
```

Contract decision:

- Do not break either command payload shape without a coordinated firmware and backend migration.
- New device-side parsers should tolerate both flat and nested command structures.

### 5.6 Inbound device/sleep payload expectations

Current handler logic accepts and normalizes mixed naming styles.

All routed inbound message families currently accept either:

- a flat JSON payload, or
- a wrapped payload under `data`

Telemetry and sleep data currently tolerate both:

- `heartRate` and `heart_rate`
- `breathingRate` and `breathing_rate`
- `bodyMovement` and `body_movement`
- `sleepState` and `sleep_state`
- `sleepScore` and `sleep_score`
- light nested as `light`

Status messages currently tolerate both:

- `bindToken` and `bind_token`
- `firmwareVersion` and `firmware_version`
- `batteryLevel` and `battery_level`, plus legacy `battery`
- `signalStrength` and `signal_strength`, plus legacy `rssi`
- light nested as `light`

Command response messages currently tolerate both:

- `commandId`, `command_id`, `cmdId`, and `cmd_id`
- `result` and `response`
- `error` and `error_message`
- missing explicit `status` when `success === false`, which is normalized to `error`

Sleep report messages currently tolerate both:

- `reportDate` and `report_date`
- `sleepDuration` and `sleep_duration`
- `sleepEfficiency` and `sleep_efficiency`
- `sleepLatency` and `sleep_latency`
- `sleepStructure` and `sleep_structure`
- `vitalSigns` and `vital_signs`
- `healthSuggestions` and `health_suggestions`

Contract decision:

- Continue accepting both `camelCase` and `snake_case` for device-originated measurement/status fields where already normalized in handlers.
- Continue accepting both flat and `{ data: ... }` payload wrappers for routed inbound MQTT messages.

## 6. Redis Contract Touchpoints

These keys are part of current runtime integration behavior and should not be changed lightly:

- `binding_code:{deviceId}`
- `provision_token:{bindToken}`
- `provision_device:{bindToken}`
- `refresh_token:{userId}`
- `refresh_token_session:{sessionId}`
- `verify_code:{type}:{phone}`
- `command_response:{commandId}`
- `command_info:{commandId}`
- `device_online:{deviceId}`
- `device_status:{deviceId}`
- `telemetry:{deviceId}`
- `light_state:{deviceId}`
- `light_alarm_schedule:{deviceId}`
- `sleep_data:{deviceId}`
- `sleep_state:{deviceId}`
- `vital_signs:{deviceId}`

## 7. Prisma Model Boundary Baseline

Source: `backend/prisma/schema.prisma`

### 7.1 Core ownership model

- `User`
  - platform user identity

- `Device`
  - physical device master record

- `UserDevice`
  - user-device binding relation
  - access control anchor for device ownership/visibility
  - unique on `(userId, deviceId)`

Contract decision:

- Device access checks are currently enforced through `UserDevice`.
- Do not bypass this relation when adding new device-scoped APIs.

### 7.2 Auth session and verification boundary

- `AuthSession`
  - refresh-session source of truth
  - stores hashed refresh token, client metadata, active/revoked lifecycle, and expiry

- `VerificationCode`
  - verification code issuance and consumption ledger
  - current runtime still keeps a Redis fallback key, but DB rows are now formal baseline

- `LoginAudit`
  - login, refresh, register, password reset, and failure audit trail

Contract decision:

- `auth_sessions`, `verification_codes`, and `login_audits` are now part of the formal backend baseline.
- Refresh-token lifecycle changes must keep Prisma, Redis compatibility keys, and JWT payload `sid` handling aligned.

### 7.3 Device provisioning and command boundary

- `DeviceProvisionToken`
  - provisioning token lifecycle for BLE/Wi-Fi onboarding

- `DeviceBindingSession`
  - manual bind, provisioning bind, refresh-code, and unbind lifecycle journal

- `DeviceCommandRecord`
  - device command dispatch/result ledger for MQTT command flows

Contract decision:

- `device_provision_tokens`, `device_binding_sessions`, and `device_command_records` are now part of the formal backend baseline.
- Provisioning, binding, and command result behavior should evolve through these tables rather than ad hoc side channels.

### 7.4 Device config boundary

- `DeviceConfig`
  - key-value config store
  - unique on `(deviceId, configKey)`
  - `configValue` is `Json`

Current known keys already used operationally:

- `light_state`
- `ota_progress`

Contract decision:

- Treat `DeviceConfig` as the extension boundary for device feature state.
- Prefer new config keys over schema churn for rapidly evolving device attributes.

### 7.5 Sleep product boundary

- `SleepPlan`
  - one-to-one by `userId`

- `SleepRoutineTemplate`
  - one-to-one by `userId`

- `SleepRoutineRecord`
  - per-user execution history

- `SleepDiary`
  - user-authored diary entries

- `SleepRelaxRecord`
  - user relaxation practice history

- `SleepReport`
  - per-device, per-date derived daily report
  - unique on `(deviceId, reportDate)`

- `VitalSignsData`
  - raw or normalized sleep/vitals time series

- `SleepStateData`
  - stage/state time series

Contract decision:

- `SleepReport` is the reporting layer.
- `VitalSignsData` and `SleepStateData` are the time-series/raw layer.
- New analytics should prefer derived reads from these layers rather than mutating report shape ad hoc.

### 7.6 Alarm boundary

- `AlarmRecord`
  - produced alarms with handling metadata

- `AlarmConfig`
  - per-device alarm threshold config

- `EmergencyContact`
  - per-user emergency contact list

### 7.7 User settings boundary

- `UserSetting`
  - per-user key-value config store
  - unique on `(userId, settingKey)`

Contract decision:

- Use `UserSetting` for additive user preferences rather than widening `User` for every setting.

## 8. Current String Convention Values

These are contract values in practice even though Prisma does not model them as DB enums.

### 8.1 Device-related

- `Device.type`
  - currently defaults to `sleep_lamp`

- `Device.status`
  - current live values include `online`, `offline`

- `UserDevice.role`
  - current live value includes `owner`

### 8.2 Auth and session-related

- `User.status`
  - current live value includes `active`

- `AuthSession.loginMethod`
  - `register`
  - `password`
  - `code`
  - `wechat`
  - `refresh`

- `AuthSession.sessionType`
  - current live value includes `app`

- `VerificationCode.status`
  - `pending`
  - `superseded`
  - `consumed`
  - `expired`
  - `locked`

- `LoginAudit.status`
  - `success`
  - `failed`

### 8.3 Auth verification

- verification code type:
  - `register`
  - `login`
  - `reset_password`

### 8.4 Device provisioning and commands

- `DeviceProvisionToken.status`
  - `pending`
  - `claimed`
  - `completed`
  - `expired`

- `DeviceBindingSession.sessionType`
  - `manual`
  - `provisioning`
  - `unbind`

- `DeviceBindingSession.status`
  - `pending`
  - `device_online`
  - `completed`
  - `expired`
  - `unbound`

- `DeviceCommandRecord.status`
  - `pending`
  - `success`
  - `failed`
  - `timeout`

### 8.5 Sleep

- sleep diary quality:
  - `excellent`
  - `good`
  - `poor`

- relax method id:
  - `breathing`
  - `muscle`
  - `meditation`

- detected sleep states used in service logic:
  - `awake`
  - `light_sleep`
  - `deep_sleep`
  - `rem_sleep`
  - `unknown`

### 8.6 OTA

- OTA progress status:
  - `downloading`
  - `installing`
  - `completed`
  - `failed`

### 8.7 Command response

- command response status:
  - `success`
  - `error`
  - `timeout`

## 9. Integration Decisions Locked For Now

- Keep both `camelCase` and `snake_case` fields where the current device APIs already expose both.
- Keep WebSocket outgoing `type` names exactly as currently emitted.
- Keep MQTT topic names exactly as currently subscribed/published.
- Keep `device/{deviceId}/command` backward compatible with both flat and wrapped payloads.
- Keep `SleepReport.reportDate` as a date-only boundary, not a full datetime contract.
- Keep `UserDevice` as the access-control join for all user-device scoped features.
- Keep `DeviceConfig` as the JSON config boundary for device feature state.

## 10. Change Policy

Any future change that touches one of the following requires explicit integration review:

- HTTP path rename
- response field rename
- removal of `snake_case` compatibility fields
- MQTT topic rename
- WebSocket `type` rename
- change to command payload structure on `device/{deviceId}/command`
- Prisma primary key or unique key change
- conversion of string convention values to stricter enums without migration

Preferred evolution path:

- add field
- add optional payload member
- add new topic
- add new config key
- add new WebSocket event type without removing old ones

Avoid:

- rename in place
- shape replacement without dual-read/dual-write window
- silent behavior changes across frontend bridge, firmware, and backend
