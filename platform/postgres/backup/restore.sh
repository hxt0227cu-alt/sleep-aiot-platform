#!/usr/bin/env bash
#
# 逻辑恢复（ADR-018）。
# 用法：restore.sh <dump-file> [target-db]
#   - 先 pg_restore -l 做完整性预检
#   - 再 pg_restore --clean --if-exists --no-owner 恢复
#   - 最后用 psql 统计 public 下表数量做健全性检查
set -euo pipefail

DUMP="${1:?用法: restore.sh <dump-file> [target-db]}"
TARGET="${2:-${PGDATABASE:-sleep_monitor}}"

if [[ ! -f "$DUMP" ]]; then
  echo "找不到 dump 文件: $DUMP" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  CONN=(--dbname="$DATABASE_URL")
else
  : "${PGHOST:?PGHOST 或 DATABASE_URL 必须提供其一}"
  : "${PGUSER:?PGUSER 必须提供}"
  CONN=(-h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" --dbname="$TARGET")
fi

if [[ -n "${PGPASSWORD:-}" && -n "${PGHOST:-}" ]]; then
  export PGPASSFILE="${PGPASSFILE:-/tmp/.pgpass_rst_$$}"
  printf '%s:%s:%s:%s:%s\n' "${PGHOST:-localhost}" "${PGPORT:-5432}" \
    "${PGDATABASE:-*}" "${PGUSER:-postgres}" "$PGPASSWORD" > "$PGPASSFILE"
  chmod 600 "$PGPASSFILE"
fi

log() { echo "[restore $(date -Iseconds)] $*"; }

log "预检 dump 完整性 (pg_restore -l)"
pg_restore -l "$DUMP" >/dev/null

log "恢复到 ${TARGET}（--clean --if-exists --no-owner）"
pg_restore --clean --if-exists --no-owner "${CONN[@]}" "$DUMP"

TABLES="$(psql "${CONN[@]}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
log "恢复完成，public 下表数量：${TABLES}"
