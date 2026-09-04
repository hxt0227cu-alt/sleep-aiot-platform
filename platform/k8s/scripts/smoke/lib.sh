#!/usr/bin/env bash
#
# lib.sh — shared helpers for the K8s runtime smoke suite.
# Sourced by run-smoke.sh. See docs/k8s-runtime-smoke.md.
#
# The suite verifies that the hardened platform workloads (non-root runAsUser,
# readOnlyRootFilesystem + matching emptyDir mounts, dropped capabilities) still
# start and serve traffic on a real cluster. Every check logs [PASS]/[FAIL]/[SKIP]
# and the runner exits non-zero if any [FAIL] was recorded.

# ---------------------------------------------------------------- counters ---
PASSED=0
FAILED=0
SKIPPED=0
declare -a FAILURES=()

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { PASSED=$((PASSED + 1)); printf '  [PASS] %s\n' "$*"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf '  [SKIP] %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); FAILURES+=("$*"); printf '  [FAIL] %s\n' "$*"; }

# ------------------------------------------------------------ preflight -----
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required command not found on PATH: $1"
    return 1
  fi
  return 0
}

cluster_reachable() {
  kubectl cluster-info >/dev/null 2>&1 || return 1
  return 0
}

# --------------------------------------------------------------- retry ------
# retry_until <seconds> <interval> <label> <command...>
# Runs <command...> repeatedly until it succeeds or the budget is exhausted.
retry_until() {
  local secs=$1 interval=$2 label=$3
  shift 3
  local elapsed=0
  while [ "$elapsed" -lt "$secs" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

# ---------------------------------------------------------------- exec ------
# kexec <namespace> <pod> <container> -- <cmd...>
# Runs a command inside a container with the container's own environment.
kexec() {
  local ns=$1 pod=$2 c=$3
  shift 3
  kubectl exec -n "$ns" "$pod" -c "$c" -- "$@"
}

# --------------------------------------------------------- wait readiness ---
wait_workload_ready() { # <namespace> <kind> <resource> <label> <timeout_secs>
  local ns=$1 kind=$2 res=$3 sel=$4 secs=$5
  local pods
  pods=$(kubectl get pods -n "$ns" -l "$sel" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [ "${pods:-0}" -eq 0 ]; then
    fail "no pods found for $sel in $ns"
    return 1
  fi
  if kubectl -n "$ns" rollout status "$kind/$res" --timeout="${secs}s" >/dev/null 2>&1; then
    ok "$kind/$res rollout complete (readiness probes green)"
    return 0
  fi
  fail "$kind/$res did not become ready within ${secs}s"
  return 1
}

# --------------------------------------------------- hardening assertions ----
# assert_non_root <ns> <pod> <container>
assert_non_root() {
  local uid
  uid=$(kexec "$1" "$2" "$3" -- id -u 2>/dev/null | tr -d '[:space:]')
  if [ -n "$uid" ] && [ "$uid" != "0" ]; then
    ok "container $3 runs as non-root (uid=$uid)"
  else
    fail "container $3 runs as root (uid=${uid:-unknown})"
  fi
}

# assert_readonly_root <ns> <pod> <container>
# Attempts to write to the container root; must fail under readOnlyRootFilesystem.
assert_readonly_root() {
  if kexec "$1" "$2" "$3" -- sh -c 'echo probe > "/readonly-probe-$$" 2>/dev/null' 2>/dev/null; then
    fail "container $3 root filesystem is WRITABLE (expected read-only)"
  else
    ok "container $3 root filesystem is read-only"
  fi
}

# assert_writable <ns> <pod> <container> <path>
# The matching emptyDir (e.g. /tmp) must remain writable for the workload.
assert_writable() {
  if kexec "$1" "$2" "$3" -- sh -c "echo probe > '$4'/smoke-probe 2>/dev/null && rm -f '$4'/smoke-probe"; then
    ok "container $3 can write to $4 (emptyDir)"
  else
    fail "container $3 CANNOT write to $4 (expected writable emptyDir)"
  fi
}

# ------------------------------------------------------------ HTTP probe ----
# probe_http_code <ns> <pod> <container> <port> <path> <accept_regex> <label>
# Uses in-pod curl/wget; the result is a [SKIP] when the image ships neither.
probe_http_code() {
  local ns=$1 pod=$2 c=$3 port=$4 path=$5 accept=$6 label=$7
  local tool code
  tool=$(kexec "$ns" "$pod" "$c" -- sh -c 'if command -v curl >/dev/null 2>&1; then echo curl; elif command -v wget >/dev/null 2>&1; then echo wget; else echo none; fi' 2>/dev/null | tr -d '[:space:]')
  case "$tool" in
    curl)
      code=$(kexec "$ns" "$pod" "$c" -- sh -c "curl -sk -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$port$path'" 2>/dev/null | tr -d '[:space:]')
      if printf '%s' "$code" | grep -Eq "$accept"; then ok "$label (http $code)"; else fail "$label (unexpected http $code)"; fi
      ;;
    wget)
      if kexec "$ns" "$pod" "$c" -- sh -c "wget -q -O /dev/null 'http://127.0.0.1:$port$path'" 2>/dev/null; then ok "$label (http 2xx)"; else fail "$label (wget failed)"; fi
      ;;
    none)
      skip "$label (no curl/wget in image; readiness already verified)"
      ;;
  esac
}

# ------------------------------------------------------------ CronJobs -----
# check_cronjob_hardened <namespace> <cronjob> <label>
# Static assertion that the CronJob pod template carries the hardened
# pod-level runAsNonRoot and container-level readOnlyRootFilesystem.
check_cronjob_hardened() {
  local ns=$1 cj=$2 label=$3
  local pod_ok=1 ctr_ok=1
  kubectl -n "$ns" get cronjob "$cj" -o jsonpath='{.spec.jobTemplate.spec.template.spec.securityContext.runAsNonRoot}' 2>/dev/null | grep -qx 'true' || pod_ok=0
  kubectl -n "$ns" get cronjob "$cj" -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem}' 2>/dev/null | grep -qx 'true' || ctr_ok=0
  if [ "$pod_ok" -eq 1 ] && [ "$ctr_ok" -eq 1 ]; then
    ok "$label: CronJob carries hardened securityContext"
  else
    fail "$label: CronJob missing hardened securityContext (runAsNonRoot=${pod_ok} readOnlyRoot=${ctr_ok})"
  fi
}

# trigger_cronjob_backfill <namespace> <cronjob> <label>
# Runs one ad-hoc Job from the CronJob template and waits for completion, then
# cleans it up. Used only with --trigger-cronjobs for the non-control-plane jobs.
trigger_cronjob_backfill() {
  local ns=$1 cj=$2 label=$3
  local job="${cj}-smoke-$(date +%s)"
  if ! kubectl -n "$ns" create job "$job" --from="cronjob/$cj" >/dev/null 2>&1; then
    skip "$label: cannot create backfill job (RBAC or suspend) - static check only"
    return 0
  fi
  if retry_until 200 5 "$label backfill" kubectl -n "$ns" wait --for=condition=complete "job/$job" --timeout=190s; then
    ok "$label: backfill job completed (hardened CronJob runs)"
  else
    fail "$label: backfill job did not complete"
  fi
  kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null 2>&1
}

# ------------------------------------------------------------- summary ------
print_summary() {
  echo ""
  echo "=== Smoke suite summary ==="
  echo "  PASSED : $PASSED"
  echo "  FAILED : $FAILED"
  echo "  SKIPPED: $SKIPPED"
  if [ "$FAILED" -gt 0 ]; then
    echo "  --- failures ---"
    for f in "${FAILURES[@]}"; do printf '    - %s\n' "$f"; done
    return 1
  fi
  return 0
}
