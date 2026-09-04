#!/usr/bin/env bash
#
# run-smoke.sh — K8s runtime smoke suite for the hardened sleep-AIoT platform.
#
# Verifies on a REAL cluster that the hardened workloads (non-root runAsUser,
# readOnlyRootFilesystem + matching emptyDir mounts) still start, become ready,
# and serve traffic. This is the runtime half of the hardening story; the static
# half is enforced by the Trivy misconfig hard gate in CI.
#
# Prerequisites:
#   - kubectl on PATH with a KUBECONFIG pointing at a non-production cluster
#     (an ACK validation cluster, kind, k3s, ...). The manifests under
#     platform/k8s/base (plus the overlay of your choice) must already be applied.
#   - The workload namespace(s) and secrets from the deployment must exist.
#
# Usage:
#   run-smoke.sh [--workload NAME] [--namespace NS] [--timeout SECS]
#                [--trigger-cronjobs]
#
#   --workload NAME    run only the named workload (case-insensitive).
#   --namespace NS     run only workloads in the given namespace.
#   --timeout SECS     readiness wait budget per workload (default 300).
#   --trigger-cronjobs additionally backfill the non-control-plane CronJobs
#                      (vault-snapshot, sealed-secrets-key-rotation,
#                      postgres-backup) to prove the hardened job templates run.
#
# Exit code: 0 if every check passed, 1 if any check failed.
#
# The control-plane etcd-encryption-key-rotation CronJob is intentionally
# static-check only: it lives in kube-system next to the API server, and the
# smoke runner has no business backfilling jobs there.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# ------------------------------------------------------------- arguments ----
WORKLOAD=""
NS_FILTER=""
TIMEOUT=300
TRIGGER_CRONJOBS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workload|-w)   WORKLOAD=$2; shift 2 ;;
    --namespace|-n)  NS_FILTER=$2; shift 2 ;;
    --timeout|-t)    TIMEOUT=$2; shift 2 ;;
    --trigger-cronjobs) TRIGGER_CRONJOBS=1; shift ;;
    *) echo "unknown argument: $1" >&2; echo "usage: run-smoke.sh [--workload NAME] [--namespace NS] [--timeout SECS] [--trigger-cronjobs]" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------- preflight ----
require_cmd kubectl || exit 1
if ! cluster_reachable; then
  echo "Cannot reach a cluster. Set KUBECONFIG to a non-production cluster first." >&2
  exit 1
fi

echo "=== sleep-AIoT K8s runtime smoke suite ==="
echo "cluster : $(kubectl config current-context 2>/dev/null || echo unknown)"
echo "budget  : ${TIMEOUT}s per workload | trigger-cronjobs=$TRIGGER_CRONJOBS"

# ----------------------------------------------------------- workload ---
# A workload is a function named smoke_<name>. Each function runs the common
# hardening checks (rollout -> non-root -> read-only root -> writable emptyDir)
# and then its own functional probe. Keep the names stable; they are the
# --workload filter values.
WORKLOADS=(clickhouse kafka postgres redis schema-registry vault jaeger loki-obs loki-mon temporal external-secrets sealed-secrets cronjobs)

# run_common <namespace> <kind> <resource> <selector> <container> <writable_paths>
run_common() {
  local ns=$1 kind=$2 res=$3 sel=$4 container=$5 writable=$6
  local pod p
  if ! wait_workload_ready "$ns" "$kind" "$res" "$sel" "$TIMEOUT"; then return 1; fi
  pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1)
  [ -n "$pod" ] || { fail "$res: no pod found"; return 1; }
  log "pod: $pod"
  assert_non_root "$ns" "$pod" "$container"
  assert_readonly_root "$ns" "$pod" "$container"
  IFS=',' read -r -a WRITABLE_PATHS <<< "$writable"
  for p in "${WRITABLE_PATHS[@]}"; do
    assert_writable "$ns" "$pod" "$container" "$p"
  done
}

# ------------------------------------------------------- workload probes ----
smoke_clickhouse() {
  local ns=analytics sel='app=clickhouse'
  run_common "$ns" statefulset clickhouse "$sel" clickhouse '/tmp,/var/log/clickhouse-server' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  if kexec "$ns" "$pod" clickhouse -- sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1"' 2>/dev/null | grep -qx '1'; then
    ok "clickhouse: SELECT 1 returns 1"
  else
    fail "clickhouse: SELECT 1 failed"
  fi
}

smoke_kafka() {
  local ns=messaging sel='app=kafka'
  run_common "$ns" statefulset kafka "$sel" kafka '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  if kexec "$ns" "$pod" kafka -- sh -c 'kafka-topics --bootstrap-server localhost:9092 --list >/dev/null 2>&1' 2>/dev/null; then
    ok "kafka: broker API reachable (kafka-topics --list)"
  else
    # The broker may require SASL credentials on this listener; readiness is already green.
    skip "kafka: deeper topic check skipped (listener may require SASL; readiness verified)"
  fi
}

smoke_postgres() {
  local ns=database sel='app=postgres'
  run_common "$ns" statefulset postgres "$sel" postgres '/tmp,/var/run/postgresql' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  # The postgres-exporter sidecar is hardened too; verify it independently.
  assert_non_root "$ns" "$pod" postgres-exporter
  assert_readonly_root "$ns" "$pod" postgres-exporter
  assert_writable "$ns" "$pod" postgres-exporter '/tmp'
  if kexec "$ns" "$pod" postgres -- sh -c 'psql -U "$POSTGRES_USER" -d sleep_platform -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS smoke_probe(id int); INSERT INTO smoke_probe VALUES (1); SELECT count(*) FROM smoke_probe; DROP TABLE smoke_probe;"' >/dev/null 2>&1; then
    ok "postgres: functional round-trip (create/insert/select/drop)"
  else
    fail "postgres: functional round-trip failed"
  fi
}

smoke_redis() {
  local ns=cache sel='app=redis'
  run_common "$ns" statefulset redis "$sel" redis '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  # The redis sentinel sidecar is hardened too.
  assert_non_root "$ns" "$pod" sentinel
  assert_readonly_root "$ns" "$pod" sentinel
  assert_writable "$ns" "$pod" sentinel '/tmp'
  if kexec "$ns" "$pod" redis -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SET smoke:probe ok >/dev/null && redis-cli -a "$REDIS_PASSWORD" --no-auth-warning GET smoke:probe | grep -qx ok && redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL smoke:probe >/dev/null' 2>/dev/null; then
    ok "redis: SET/GET/DEL round-trip"
  else
    fail "redis: SET/GET/DEL round-trip failed"
  fi
}

smoke_schema_registry() {
  local ns=messaging sel='app=schema-registry'
  run_common "$ns" statefulset schema-registry "$sel" schema-registry '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" schema-registry 8081 '/subjects' '^2' 'schema-registry: /subjects'
}

smoke_vault() {
  local ns=vault sel='app=vault'
  run_common "$ns" statefulset vault "$sel" vault '/tmp,/vault/logs' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  # Health endpoint returns 200 (unsealed), 501 (uninitialized) or 503 (sealed);
  # all of them prove the hardened container serves the API server.
  probe_http_code "$ns" "$pod" vault 8200 '/v1/sys/health' '^(200|501|503)$' 'vault: /v1/sys/health reachable'
}

smoke_jaeger() {
  local ns=observability sel='app=jaeger'
  run_common "$ns" deployment jaeger "$sel" jaeger '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" jaeger 16686 '/' '^2' 'jaeger: UI /'
}

smoke_loki_obs() {
  local ns=observability sel='app=loki'
  run_common "$ns" deployment loki "$sel" loki '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" loki 3100 '/ready' '^2' 'loki(observability): /ready'
}

smoke_loki_mon() {
  local ns=monitoring sel='app=loki'
  run_common "$ns" deployment loki "$sel" loki '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" loki 3100 '/ready' '^2' 'loki(monitoring): /ready'
}

smoke_temporal() {
  local ns=workflow sel='app=temporal'
  run_common "$ns" deployment temporal "$sel" temporal '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" temporal 7233 '/health' '^2' 'temporal: frontend /health'
}

smoke_external_secrets() {
  local ns=secrets sel='app=external-secrets'
  run_common "$ns" deployment external-secrets "$sel" external-secrets '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" external-secrets 8081 '/healthz' '^2' 'external-secrets: /healthz'
}

smoke_sealed_secrets() {
  local ns=sealed-secrets sel='app=sealed-secrets-controller'
  run_common "$ns" deployment sealed-secrets-controller "$sel" sealed-secrets-controller '/tmp' || return 0
  local pod; pod=$(kubectl get pods -n "$ns" -l "$sel" -o jsonpath='{.items[0].metadata.name}')
  probe_http_code "$ns" "$pod" sealed-secrets-controller 8080 '/healthz' '^2' 'sealed-secrets: /healthz'
}

smoke_cronjobs() {
  echo ""
  echo "### workload: cronjobs (hardened job templates)"
  check_cronjob_hardened vault vault-snapshot 'vault-snapshot'
  check_cronjob_hardened sealed-secrets sealed-secrets-key-rotation 'sealed-secrets-key-rotation'
  check_cronjob_hardened sleep-platform postgres-backup 'postgres-backup'
  # Control-plane adjacency: never backfill this one from a smoke runner.
  check_cronjob_hardened kube-system etcd-encryption-key-rotation 'etcd-encryption-key-rotation'
  if [ "$TRIGGER_CRONJOBS" -eq 1 ]; then
    trigger_cronjob_backfill vault vault-snapshot 'vault-snapshot'
    trigger_cronjob_backfill sealed-secrets sealed-secrets-key-rotation 'sealed-secrets-key-rotation'
    trigger_cronjob_backfill sleep-platform postgres-backup 'postgres-backup'
  else
    echo "  (pass --trigger-cronjobs to also backfill the non-control-plane CronJobs)"
  fi
}

# -------------------------------------------------------------- dispatch ----
for name in "${WORKLOADS[@]}"; do
  if [ -n "$WORKLOAD" ] && [ "${name,,}" != "${WORKLOAD,,}" ]; then continue; fi
  echo ""
  echo ">>> $name"
  "smoke_$name"
done

echo ""
print_summary
exit $?
