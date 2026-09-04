# K8s Runtime Smoke Suite

The static hardening work (non-root `runAsUser`, `readOnlyRootFilesystem` with
matching `emptyDir` mounts, dropped capabilities) is enforced by the Trivy
misconfig **hard gate** in CI. That gate only proves the manifests are shaped
correctly — it cannot prove the images still start and serve traffic once the
root filesystem is read-only.

This suite closes that gap: it runs on a **real cluster** and verifies, for
every hardened workload, that the pod comes up Ready, runs as a non-root user,
cannot write to its root filesystem, can still write to the matching `emptyDir`
mounts, and answers its own health / functional probes.

## When to run it

- After applying the hardened manifests to a staging / validation cluster
  (ACK validation cluster, kind, k3s, ...).
- Before any production rollout that includes the hardening changes.
- As a routine post-deploy check.

## Prerequisites

- `kubectl` on `PATH`, with `KUBECONFIG` pointing at a **non-production**
  cluster.
- The manifests for the platform (the `platform/k8s/base` plus your chosen
  overlay, e.g. `platform/k8s/overlays/validation`) must already be applied.
- The workload namespaces, Secrets and the ClusterSecretStore / SealedSecret
  bootstrap must exist (they are part of the same deployment).
- A service account with read access to workloads and (only when using
  `--trigger-cronjobs`) permission to create Jobs in `vault`, `sealed-secrets`
  and `sleep-platform`.

## Usage

```bash
# Full run (read-only + static CronJob checks)
./platform/k8s/scripts/smoke/run-smoke.sh

# One workload
./platform/k8s/scripts/smoke/run-smoke.sh --workload postgres

# One namespace
./platform/k8s/scripts/smoke/run-smoke.sh --namespace analytics

# Relax the per-workload readiness budget
./platform/k8s/scripts/smoke/run-smoke.sh --timeout 600

# Also backfill the non-control-plane CronJobs to prove they run hardened
./platform/k8s/scripts/smoke/run-smoke.sh --trigger-cronjobs
```

Exit code is `0` only when every check passed; `1` when at least one check
failed. A failed check is printed with the reason, and a summary block with
`PASSED / FAILED / SKIPPED` counts is printed at the end.

## Coverage matrix

Every workload is checked for: rollout readiness → runs as non-root →
root filesystem read-only → matching `emptyDir` writable → functional probe.

| Workload | Namespace | Kind | Containers checked | Writable emptyDir paths | Functional probe |
|---|---|---|---|---|---|
| clickhouse | analytics | StatefulSet | clickhouse | /tmp, /var/log/clickhouse-server | `SELECT 1` |
| kafka | messaging | StatefulSet | kafka | /tmp | topic list (skips if SASL-only) |
| postgres | database | StatefulSet | postgres, postgres-exporter | /tmp, /var/run/postgresql | create/insert/select/drop |
| redis | cache | StatefulSet | redis, sentinel | /tmp | SET/GET/DEL |
| schema-registry | messaging | StatefulSet | schema-registry | /tmp | `GET /subjects` |
| vault | vault | StatefulSet | vault | /tmp, /vault/logs | `GET /v1/sys/health` |
| jaeger | observability | Deployment | jaeger | /tmp | `GET /` (UI) |
| loki (observability) | observability | Deployment | loki | /tmp | `GET /ready` |
| loki (monitoring) | monitoring | Deployment | loki | /tmp | `GET /ready` |
| temporal | workflow | Deployment | temporal | /tmp | `GET /health` |
| external-secrets | secrets | Deployment | external-secrets | /tmp | `GET /healthz` |
| sealed-secrets | sealed-secrets | Deployment | sealed-secrets-controller | /tmp | `GET /healthz` |
| vault-snapshot | vault | CronJob | — | — | static securityContext + optional backfill |
| sealed-secrets-key-rotation | sealed-secrets | CronJob | — | — | static securityContext + optional backfill |
| postgres-backup | sleep-platform | CronJob | — | — | static securityContext + optional backfill |
| etcd-encryption-key-rotation | kube-system | CronJob | — | — | static securityContext only (control-plane) |

## How to read the results

- `[PASS]` — the check verified what it claims.
- `[FAIL]` — a hardening regression or a broken workload. The suite exits `1`.
- `[SKIP]` — the check could not be executed in this environment (for example
  an image without `curl`/`wget` for the HTTP probe, or a SASL-protected Kafka
  listener). A `[SKIP]` is not a failure, but it is also **not** proof that the
  probe works — the workload readiness already passed in that case.

## Interpreting known sensitive checks

- **vault health** accepts HTTP `200` (unsealed), `501` (uninitialized) and
  `503` (sealed). All three mean the hardened container is serving the API
  server; sealing is an operational state, not a hardening failure.
- **kafka** `kafka-topics --list` may need SASL credentials depending on the
  listener; when it fails the check is skipped (readiness already proves the
  broker is healthy). Wire client properties for a deeper check if needed.
- **etcd-encryption-key-rotation** is only checked statically. It lives in
  `kube-system` next to the API server; a smoke runner must never backfill it.
  The KMS plugin itself is a documented by-design exception (see
  `docs/security.md`) and is not part of this suite.

## CI integration

A `k8s-runtime-smoke` job in `.github/workflows/enterprise-platform-ci.yml`
can run this suite against a real cluster. It is `workflow_dispatch`-only and
is gated on a `KUBE_CONFIG` secret, so it never blocks the default CI:

1. Put a `kubeconfig` for a non-production cluster into the repository secret
   `KUBE_CONFIG`.
2. Trigger the workflow from the Actions tab → "Enterprise Platform CI" →
   Run workflow, or via `gh workflow run enterprise-platform-ci.yml`.
3. Inspect the `k8s-runtime-smoke` job logs for the `PASSED / FAILED` summary.

## Known limitations

- The suite validates **runtime behavior**, not security posture itself — a
  pod running as root would be caught, but the suite does not re-scan images.
- Functional probes depend on the images shipping `psql`, `clickhouse-client`,
  `redis-cli`, `kafka-topics`, `curl` or `wget`. Probes that cannot run are
  skipped, not failed.
- Backfill jobs (`--trigger-cronjobs`) create and delete short-lived Jobs in
  the workload namespaces; they must not be run against production.
