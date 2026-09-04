# ADR-003: Separate durable workflow lifecycle from bounded agent reasoning

Status: Accepted

## Context

Agent tasks can wait for approval, outlive an API process, retry external tools, and require versioned audit evidence. A single synchronous LLM request does not provide these guarantees.

## Decision

Use a durable Agent Run contract. Temporal is the production workflow coordinator; LangGraph is the bounded reasoning graph inside workflow activities. The local profile keeps an SQLite/in-process compatibility boundary. The production profile uses PostgreSQL shared state and starts Temporal API workers in every Agent Service replica; approval and cancellation are durable workflow signals.

Device writes wait for approval. The operations Agent is read-only. Every run is tenant scoped, cancellable, bounded by steps/time/tokens, and audit logged.

## Consequences

- Worker restarts do not lose production workflow state.
- Human approval and cancellation are first-class states.
- Temporal adds operational cost; it is justified only for long-running production workflows.
- Local validation must clearly state when it uses the lightweight workflow boundary.

## 2026-08-01 implementation amendment

- `AGENT_STATE_BACKEND=postgres` and `AGENT_COORDINATOR=temporal` are required by the Kubernetes deployment.
- A stable `sleep-agent-run-{run_id}` workflow ID makes outbox retries idempotent. Temporal history owns dispatch and recovery; PostgreSQL stores tenant-scoped query snapshots.
- RuntimeContext, capability versions and RunBudget are persisted with every execution snapshot. Oversized results are evicted to the tenant Workspace without compacting permission or budget state.
- The repository has unit and static deployment evidence only. Worker interruption, approval waiting across rollout and database migration are still unverified in staging.
