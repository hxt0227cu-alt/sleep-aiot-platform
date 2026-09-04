#!/usr/bin/env bash
#
# 恢复健全性演练（ADR-018）：把给定 dump 恢复到临时库，跑断言后丢弃。
# 用法：verify-restore.sh <dump-file>
set -euo pipefail

DUMP="${1:?用法: verify-restore.sh <dump-file>}"
if [[ ! -f "$DUMP" ]]; then echo "找不到 dump: $DUMP" >&2; exit 1; fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  BASE="$DATABASE_URL"
  ADMIN_DSN="$(printf '%s' "$BASE" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')"
  TMPDB="$(printf '%s' "$BASE" | sed -E 's#.*/([^/?]+).*#\1#')_verify_$(date +%s)"
else
  : "${PGHOST:?PGHOST 或 DATABASE_URL 必须提供其一}"
  : "${PGUSER:?PGUSER 必须提供}"
  ADMIN_DSN=(-h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" --dbname=postgres)
  TMPDB="${PGDATABASE:-sleep_monitor}_verify_$(date +%s)"
fi

if [[ -n "${PGPASSWORD:-}" && -n "${PGHOST:-}" ]]; then
  export PGPASSFILE="${PGPASSFILE:-/tmp/.pgpass_vrf_$$}"
  printf '%s:%s:%s:%s:%s\n' "${PGHOST:-localhost}" "${PGPORT:-5432}" \
    "${PGDATABASE:-*}" "${PGUSER:-postgres}" "$PGPASSWORD" > "$PGPASSFILE"
  chmod 600 "$PGPASSFILE"
fi

log() { echo "[verify $(date -Iseconds)] $*"; }

log "预检 dump 完整性"
pg_restore -l "$DUMP" >/dev/null

log "创建临时库 ${TMPDB}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql "$ADMIN_DSN" -c "CREATE DATABASE \"${TMPDB}\";"
  RESTORE_DSN="$(printf '%s' "$BASE" | sed -E "s#/[^/?]+(\?.*)?\$#/${TMPDB}#")"
else
  psql "${ADMIN_DSN[@]}" -c "CREATE DATABASE \"${TMPDB}\";"
  RESTORE_DSN=(-h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" --dbname="$TMPDB")
fi

log "恢复到临时库"
pg_restore --clean --if-exists --no-owner "${RESTORE_DSN[@]}" "$DUMP"

COUNT="$(psql "${RESTORE_DSN[@]}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
if [[ "${COUNT:-0}" -gt 0 ]]; then
  log "OK: 临时库恢复成功，public 表数量=${COUNT}"
else
  log "FAIL: 恢复后无表"
  psql "${ADMIN_DSN[@]}" -c "DROP DATABASE IF EXISTS \"${TMPDB}\";" || true
  exit 1
fi

log "清理临时库 ${TMPDB}"
psql "${ADMIN_DSN[@]}" -c "DROP DATABASE IF EXISTS \"${TMPDB}\";"
log "演练结束 OK"
