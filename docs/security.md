# Security posture and CI gates

This document describes how the repository enforces security in CI, and the
known infrastructure-hardening backlog that is reported but intentionally not
force-fixed.

## What CI enforces (hard gates, failing the build)

- **Dependency vulnerabilities (Trivy `vuln`)**: any fixed HIGH or CRITICAL
  vulnerability in any lockfile (`pnpm-lock.yaml`, `package-lock.json`) fails
  the `security` job. Unfixed advisories are reported but do not fail the build
  (they cannot be patched by us).
- **Secrets (Trivy `secret`)**: hardcoded credentials, tokens and private keys
  anywhere in the repository fail the build.
- **Repeatedly verified**: these scans run on every push to `main` and on every
  pull request touching `services/**`, `platform/**` or the workflow itself.

## What CI reports but does not fail (advisory)

Infrastructure **misconfigurations** (Trivy `misconfig`, e.g. KSV-0014 /
KSV-0118 / KSV-0041 / KSV-0046) are printed in the job log and uploaded as a
SARIF artifact for every run (`trivy-results.sarif`). They do not fail the
build because several of them are by design and a blind fix would break the
manifests:

- **External Secrets operator** needs `create/update/patch/delete` on
  `secrets` to synchronize SecretStores into the cluster. Restricting this
  ClusterRole would disable the operator; the correct scope control is
  enforced at the `ClusterSecretStore` level with namespace-scoped
  `ServiceAccount` bindings.
- **Stateful images** (`postgres`, `clickhouse`, `kafka`, `redis`, `vault`)
  run as their own well-known non-root users and write to mounted volumes.
  Setting `readOnlyRootFilesystem: true` or `runAsNonRoot` without the matching
  writable `emptyDir` mounts (e.g. `/tmp`, `/var/run`) and per-image
  `runAsUser` would break the workloads at runtime.

## Hardening backlog (tracked)

| Finding | Scope | Effort | Why not force-fixed yet |
| --- | --- | --- | --- |
| KSV-0014 readOnlyRootFilesystem | ~18 workloads | M | Requires per-image writable `emptyDir` mounts and verification |
| KSV-0118 default security context | ~20 workloads | M | Requires per-image `runAsUser` matching the image's user |
| KSV-0041/0046 broad ClusterRoles | 5 roles | S | `external-secrets`/`secret-manager` need Secret write by design; scope via namespaced Roles where possible |

The manifests are deployment references rendered and validated by
`kustomize build` in CI (`platform-manifests` job); they are not applied
automatically. Hardening is a follow-up tracked in the project's GitHub
issues.

## Reporting

Found a real vulnerability? See [SECURITY.md](../SECURITY.md) for the
coordinated-disclosure process.
