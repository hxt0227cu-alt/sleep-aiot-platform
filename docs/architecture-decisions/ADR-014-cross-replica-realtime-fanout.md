# ADR-014: Cross-Replica Realtime Fan-out

Status: Proposed

Date: 2026-07-31

Governed by ADR-012. Required by ADR-013.

## Context

The realtime gateway is process-local. `backend/src/websocket/websocket.gateway.ts:11` imports the bare `ws` library, and `:28-31` holds four in-process maps: `clients`, `userClients`, `deviceClients`, `heartbeats`. The three fan-out entry points — `broadcastToDevice` at `:200`, `broadcastToUser` at `:220`, `broadcastToAll` at `:238` — iterate only those local maps.

At `replicas: 3` the failure is straightforward. A user's socket is terminated by replica A. An alarm for that user is handled by replica B, because the load balancer distributed the triggering request or, after ADR-013, because the shared subscription delivered the MQTT message to B. `broadcastToUser` on B finds no entry and returns. Nothing is logged as an error, because from B's perspective the user is simply not connected. The probability that a given event reaches its target is roughly `1/N`.

`broadcastToAll` is worse: it reaches one third of connected clients and reports success.

The bare `ws` library is a deliberate constraint. Three clients depend on the current wire protocol — `src/` (web and Capacitor Android) and `miniprogram/` — and WeChat mini-program networking does not use the Socket.IO client. Replacing the transport is a coordinated breaking change across three release trains, which is out of proportion to the defect being fixed.

`backend/src/redis/redis.service.ts` already exposes `publish()` at `:68` and `getClient()` at `:23` returning an ioredis instance, so the necessary primitive is present and connected.

## Decision

Keep the bare `ws` transport and the existing wire protocol. Insert a Redis Pub/Sub fan-out layer between event production and socket delivery. Clients change nothing.

### Delivery path

Every replica publishes to Redis and every replica subscribes. The originating replica delivers to its own sockets through the subscription path, not directly.

```
event on replica B
  -> RedisService.publish('ws:fanout', envelope)
  -> all replicas receive on their subscriber connection
  -> each replica matches envelope.target against its local maps
  -> replica A finds the socket and writes; B and C no-op
```

Publishing without a local shortcut is deliberate. A local fast path would create two code paths with different ordering and different failure behaviour, and the same-replica case is the one that already works today, so it is the case least in need of optimisation. One path is one thing to test.

### Channel design

A single channel, `ws:fanout`, carrying an envelope of `{ target: {kind, id}, payload, publishedAt }`. Each replica filters locally.

This is deliberately the unsophisticated option. At the declared capacity in `202607worklog/architecture/01-capacity-model.md` — 2,000 peak connected clients across at most 20 replicas — every replica receiving every envelope costs one small message per replica per event. The alternative, per-subject channels with dynamic subscribe and unsubscribe on every connect and disconnect, trades that cheap bandwidth for subscription churn proportional to connection churn, which is the more volatile quantity.

The migration trigger is recorded now so it is a measurement rather than an argument: move to per-subject channels when sustained `ws:fanout` publish rate exceeds 2,000 messages per second or when replica CPU attributable to envelope filtering exceeds 5%. Below that, single channel stands.

### Delivery semantics are at-most-once, and that is the contract

Redis Pub/Sub does not persist. A replica disconnected from Redis for two seconds loses every envelope published in that window, with no recovery. This is accepted, and the compensating mechanism is explicit: the realtime channel is a latency optimisation over the REST API, never the system of record. Clients reconcile by fetching current state on connect and on reconnect, and every pushed payload must be a state snapshot or carry enough context to be safely discarded, never a delta that assumes the previous message arrived.

Any feature that cannot tolerate a lost push does not use this channel. It uses the outbox in `backend/src/outbox/outbox.service.ts`, which is already durable.

### Presence is separate from connection handling

The local maps stay local — a replica holding the sockets it terminates is permitted by ADR-012. What moves to Redis is the question other replicas need answered: *is this subject connected anywhere*. That is a Redis set per subject with a TTL refreshed by the existing heartbeat at `websocket.gateway.ts:256`, and removed on clean disconnect. The heartbeat timer itself stays local and unlocked, because it only touches sockets this replica owns.

### Implementation constraints

- ioredis requires a dedicated connection in subscriber mode. The gateway uses `getClient().duplicate()`, not the shared command client.
- Subscriber reconnection must re-establish the subscription and increment a counter. A silently dead subscriber is indistinguishable from an idle system, so this counter is an alert, not a debug metric.
- Slow-consumer policy: before writing, check `socket.bufferedAmount` against a bound. Over the bound, drop the client rather than the process. Unbounded per-socket buffers turn one stalled mobile client into a replica memory leak.

## Consequences

### Easier

- Delivery probability goes from roughly `1/N` to independent of `N`. Scale-out stops degrading realtime.
- `broadcastToAll` becomes truthful.
- Rolling deploys with `maxUnavailable: 0` stop dropping events for clients that reconnect to a new pod.
- The client contract is unchanged, so this ships without coordinating web, mini-program and Android releases.

### Harder

- Redis becomes a hard dependency of realtime delivery. Its availability now bounds the realtime SLO, and a single-node Redis is a correlated failure against the 99.95% objective in the capacity model. Redis HA and a documented degraded mode are prerequisites, not follow-ups.
- Every delivery gains a Redis round trip, including deliveries to the same replica. Median latency increases. The budget is the "first progress event below 1 second" objective, which has ample headroom, but the regression must be measured rather than assumed.
- At-most-once must be enforced by review. The moment one feature pushes a delta instead of a snapshot, the contract silently becomes at-least-once-or-broken, and the failure appears only under Redis disruption.
- `platform/local/` must start Redis for the gateway to work at all, so local development gains a dependency.

## Rejected alternatives

- **Socket.IO with `@socket.io/redis-adapter`.** Mature, well-understood, gives rooms and reconnection for free. Rejected because it changes the wire protocol, forcing simultaneous breaking releases of web, WeChat mini-program and Android clients to fix a server-side defect. The cost lands on three teams and three release trains to buy convenience for one.
- **Sticky sessions at the load balancer.** Rejected as an architecture, not just here: it makes correctness depend on load-balancer configuration that no test in this repository can observe, and it still loses events on scale-in and rolling deploy, which are routine rather than exceptional.
- **Redis Streams with a consumer group per replica.** Would provide durability and replay. Rejected as disproportionate: it requires per-replica group lifecycle management and stream trimming, and it solves a durability problem that client-side reconciliation already solves more cheaply. Revisit if at-most-once proves insufficient in practice, which would be evidence, not speculation.
- **A dedicated push-gateway service.** The cleanest boundary, and the likely destination. Deferred rather than rejected: extracting it now adds a service to orchestrate, monitor and staff before the five existing services in `services/` have any Kubernetes manifests at all. The trigger to revisit is realtime connection handling becoming an independent scaling axis from API traffic — concretely, when connection count drives backend replica count more than request rate does.

## Verification status

Local evidence verified 2026-08-04: a real Redis instance served two service instances and delivered the cross-instance fan-out assertion. Redis disruption/reconciliation and real staging HA remain unverified; Redis Pub/Sub is still intentionally not the system of record.
