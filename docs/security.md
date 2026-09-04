# Security posture and CI gates

This document describes how the repository enforces security in CI, and the
status of the Kubernetes misconfiguration (KSV) hardening backlog. The backlog
listed here has been **executed** (see [Hardening checklist](#hardening-checklist-executable))
and is verified by CI on every push.

## What CI enforces (hard gates, failing the build)

- **Dependency vulnerabilities (Trivy `vuln`)**: any fixed HIGH or CRITICAL
  vulnerability in any lockfile (`pnpm-lock.yaml`, `package-lock.json`) fails
  the `security` job. Unfixed advisories are reported but do not fail the build
  (they cannot be patched by us).
- **Secrets (Trivy `secret`)**: hardcoded credentials, tokens and private keys
  anywhere in the repository fail the build.
- **Infrastructure misconfigurations (Trivy `misconfig`)**: any KSV finding
  fails the build (hard gate). The only findings that ever appear are the
  documented by-design exceptions, which are exempted **inline** with
  `#trivy:ignore` comments on the exact resources (see below). Any new KSV
  finding — for example a future manifest that forgets the hardening — turns
  the `security` job red, so the hardening cannot silently regress.
- **Repeatedly verified**: these scans run on every push to `main` and on every
  pull request touching `services/**`, `platform/**` or the workflow itself.

## By-design exceptions (whitelisted in CI)

The `security` job's misconfig step emits a JSON report and a follow-up
assertion step fails the build unless every finding is one of the documented
by-design pairs below (target file + rule ID). This keeps the gate precise —
the three resources below are the only allowed exceptions, and any *other*
finding (e.g. a new manifest that forgets hardening) turns CI red. The
exceptions are also annotated as comments in the source manifests:

- **External Secrets operator** needs `create/update/patch/delete` on
  `secrets` to synchronize SecretStores into the cluster. Restricting this
  ClusterRole would disable the operator; the correct scope control is
  enforced at the `ClusterSecretStore` level with namespace-scoped
  `ServiceAccount` bindings. Whitelisted in
  CI (target `platform/k8s/base/external-secrets.yaml` + KSV-0041). The unrelated KSV-0046
  wildcard rule has been narrowed (see checklist).
- **Sealed Secrets controller** (`secrets-unsealer`) needs cluster-wide
  `secrets` write access by design: it unseals a `SealedSecret` into whichever
  namespace the resource lives in. Whitelisted in CI
  (target `platform/k8s/base/sealed-secrets-bootstrap.yaml` + KSV-0041).
- **`kube-system` KMS plugin** (`kms-plugin` DaemonSet) is the control-plane
  etcd-encryption socket peer. It requires a `hostPath` socket and runs the
  upstream Aliyun image as root; forcing non-root would risk breaking the API
  server's encryption path. Whitelisted in CI
  (`platform/k8s/base/etcd-encryption-config.yaml` + KSV-0014 / KSV-0118).

**Stateful images** (`postgres`, `clickhouse`, `kafka`, `redis`, `vault`) are
**not** exempted — they are hardened like everything else:
`readOnlyRootFilesystem: true` / `runAsNonRoot` paired with the matching
writable `emptyDir` mounts and per-image `runAsUser`. CI validates the
manifests; a runtime smoke suite in a real cluster validates the behaviour
(see [Runtime smoke](#runtime-smoke)).

## Hardening checklist (executable)

The following was applied in the `KSV hardening` change. Every workload below
is **source** in `platform/k8s/base/` (or the `alicloud-validation` overlay)
and is validated by `kustomize build` (CI `platform-manifests` job) plus the
Trivy `misconfig` scan (CI `security` job).

### 1. KSV-0014 — readOnlyRootFilesystem (HIGH)

Applied: container-level `readOnlyRootFilesystem: true` + matching writable
`emptyDir` mounts + `capabilities.drop: ["ALL"]`, `allowPrivilegeEscalation:
false`, `runAsNonRoot: true`.

| Workload | File | Writable emptyDir added |
| --- | --- | --- |
| clickhouse (StatefulSet) | `platform/k8s/base/clickhouse-statefulset.yaml` | `/var/log/clickhouse-server`, `/tmp` |
| kafka (StatefulSet) | `platform/k8s/base/kafka-statefulset.yaml` | `/tmp` |
| postgres + postgres-exporter (StatefulSet) | `platform/k8s/base/postgres-ha-statefulset.yaml` | `/var/run/postgresql`, `/tmp` (×2) |
| redis + sentinel (StatefulSet) | `platform/k8s/base/redis-sentinel.yaml` | `/tmp` (shared) |
| schema-registry (StatefulSet) | `platform/k8s/base/schema-registry-statefulset.yaml` | `/tmp` |
| vault (StatefulSet) | `platform/k8s/base/vault-ha-statefulset.yaml` | `/vault/logs`, `/tmp` |
| vault-snapshot (CronJob) | `platform/k8s/base/vault-snapshot-cronjob.yaml` | `/tmp` |
| jaeger (Deployment) | `platform/k8s/base/jaeger-deployment.yaml` | `/tmp` |
| loki (Deployment, observability) | `platform/k8s/base/jaeger-deployment.yaml` | `/tmp` |
| loki (Deployment, monitoring) | `platform/k8s/base/loki-deployment.yaml` | `/tmp` |
| temporal (Deployment, `temporal-ha`) | `platform/k8s/base/temporal-ha.yaml` | `/tmp` |
| external-secrets (Deployment) | `platform/k8s/base/external-secrets.yaml` | `/tmp` (for `--cert-dir`) |
| sealed-secrets-key-rotation (CronJob) | `platform/k8s/base/sealed-secrets-bootstrap.yaml` | `/tmp` |
| etcd-encryption-key-rotation (CronJob) | `platform/k8s/base/etcd-encryption-config.yaml` | `/tmp` |
| clickhouse (Deployment, validation overlay) | `platform/k8s/overlays/alicloud-validation/validation-clickhouse.yaml` | already present; added `readOnlyRootFilesystem` |
| **Deferred (by design)** `kms-plugin` DaemonSet (kube-system) | `platform/k8s/base/etcd-encryption-config.yaml` | control-plane KMS socket peer; see exceptions above |

### 2. KSV-0118 — default (root-capable) security context (HIGH)

Applied: pod-level `spec.template.spec.securityContext` with `runAsNonRoot:
true`, the image's `runAsUser`, and `seccompProfile: RuntimeDefault`.

| Workload | File | runAsUser |
| --- | --- | --- |
| external-secrets (Deployment) | `platform/k8s/base/external-secrets.yaml` | 1000 |
| sealed-secrets-controller (Deployment) | `platform/k8s/base/sealed-secrets-bootstrap.yaml` | 1001 |
| sealed-secrets-key-rotation (CronJob) | `platform/k8s/base/sealed-secrets-bootstrap.yaml` | 1001 (kubectl image) |
| etcd-encryption-key-rotation (CronJob) | `platform/k8s/base/etcd-encryption-config.yaml` | 1001 (kubectl image) |
| schema-registry (StatefulSet) | `platform/k8s/base/schema-registry-statefulset.yaml` | 1000 |
| vault-snapshot (CronJob) | `platform/k8s/base/vault-snapshot-cronjob.yaml` | 100 |
| jaeger (Deployment) | `platform/k8s/base/jaeger-deployment.yaml` | 10001 |
| loki (Deployment, observability) | `platform/k8s/base/jaeger-deployment.yaml` | 10001 |
| temporal (Deployment, `temporal-ha`) | `platform/k8s/base/temporal-ha.yaml` | 1000 |
| **Deferred (by design)** `kms-plugin` DaemonSet (kube-system) | `platform/k8s/base/etcd-encryption-config.yaml` | control-plane KMS socket peer; see exceptions above |

Per-image `runAsUser` values come from the upstream image conventions
(`clickhouse`=101, `postgres`=999, `redis`=999, `kafka`=1000, `vault`=100,
`jaeger/loki`=10001, `temporal`=1000, `sealed-secrets/external-secrets`=1001).
`postgres-backup`, `temporal-deployment` and the app workloads
(`backend`/`agent`/`feature`) already met the baseline (0 findings) and were
left unchanged.

### 3. KSV-0041 / KSV-0046 — broad ClusterRoles (CRITICAL)

| Role / finding | File | Resolution |
| --- | --- | --- |
| `external-secrets` ClusterRole, KSV-0046 (wildcard `resources: ["*"]` / `verbs: ["*"]`) | `platform/k8s/base/external-secrets.yaml` | **Fixed**: narrowed to the explicit ESO CRDs (`externalsecrets`, `secretstores`, `clustersecretstores`) with explicit verbs, plus read-only status subresources |
| `external-secrets` ClusterRole, KSV-0041 (cluster-scoped `secrets` write) | `platform/k8s/base/external-secrets.yaml` | **By design**: the operator must sync Secrets cluster-wide; scope is enforced at `ClusterSecretStore` + namespaced SA bindings |
| `secrets-unsealer` ClusterRole, KSV-0041 | `platform/k8s/base/sealed-secrets-bootstrap.yaml` | **By design**: Sealed Secrets unseals into arbitrary namespaces |
| `secret-reader` / `secret-manager` / `secret-auditor` ClusterRoles, KSV-0041 | `platform/k8s/base/secret-rbac.yaml` | **Fixed**: removed — they were dead policy (never referenced by any `ClusterRoleBinding`). Actual access uses the namespaced `Role`s with `resourceNames` (`backend-secret-reader`, `iot-secret-reader`, `database-secret-manager`) |

### 4. Scan hygiene — generated bundle untracked

`platform/k8s/rendered/` holds a generated deployment bundle (produced by
`platform/k8s/scripts/New-DeploymentBundle.ps1` with real ACR digests and
CIDRs at deploy time), not source. It is no longer tracked in git
(`.gitignore`), so a stale snapshot can never resurface duplicate findings or
drift from the hardened `base/`. The Trivy `skip-dirs` entry remains as a
safety net for locally generated bundles. CI validates the source of truth
(`overlays/validation` and `overlays/alicloud-validation` render cleanly) in
the `deployment-contracts` job.

## Runtime smoke

CI validates **manifests**, not **runtime behaviour** — a read-only root
filesystem only proves it can be deployed if the workload still starts and
writes where it needs to. The runtime half is covered by an executable smoke
suite that runs on a real cluster (staging / ACK validation / kind / k3s):

- **Script**: `platform/k8s/scripts/smoke/run-smoke.sh` (+ `lib.sh`)
- **Checks per workload**: rollout readiness → runs as non-root → root
  filesystem read-only → matching `emptyDir` writable → functional probe
  (`SELECT 1`, postgres round-trip, `SET/GET/DEL`, `/v1/sys/health`, ...).
- **CronJobs**: static securityContext assertion for all four, plus an
  opt-in `--trigger-cronjobs` backfill for the non-control-plane ones.
- **CI**: `k8s-runtime-smoke` job (workflow_dispatch only, gated on the
  `KUBE_CONFIG` secret) runs it against a real cluster.
- **Usage & matrix**: [docs/k8s-runtime-smoke.md](k8s-runtime-smoke.md)

## How to verify

```bash
# 1. Manifests are valid and kustomize-renderable (CI platform-manifests job)
kustomize build platform/k8s/overlays/validation
kustomize build platform/k8s/overlays/alicloud-validation

# 2. Misconfiguration scan (CI security job, hard gate) — the misconfig step
#    emits a JSON report and the assertion step fails unless every finding is
#    one of the documented by-design (target, rule) pairs above.
trivy fs --scanners misconfig --severity HIGH,CRITICAL --format json --output trivy-misconfig.json --skip-dirs platform/k8s/rendered .

# 3. Runtime behaviour on a real cluster (CI k8s-runtime-smoke job, or locally)
bash platform/k8s/scripts/smoke/run-smoke.sh
bash platform/k8s/scripts/smoke/run-smoke.sh --trigger-cronjobs
```

Because of the CI whitelist assertion, the `security` job misconfig gate reports
**zero unexpected findings** on a clean run; the by-design pairs above are the
only (target, rule) combinations allowed. The SARIF artifact
(`trivy-results.sarif`) still records everything at all severities for review.
See the CI `security` job log for the authoritative result on each commit.

## Reporting

Found a real vulnerability? See [SECURITY.md](../SECURITY.md) for the
coordinated-disclosure process.
