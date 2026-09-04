#!/usr/bin/env bash
#
# 逻辑全量备份（ADR-018）。
# 每次运行产出一个 pg_dump -Fc（custom format，压缩）dump 文件。
# 可选：上传对象存储（S3/MinIO）、按保留期清理。
#
# 依赖：pg_dump（PostgreSQL 客户端，版本建议 >= 服务端版本）。
# 认证：优先读 DATABASE_URL；否则读 libpq 环境变量
#       (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)，并写临时 .pgpass。
set -euo pipefail

# ---- 参数（均可环境变量覆盖）-------------------------------------------
DB_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
LOCK_FILE="${BACKUP_DIR}/.backup.lock"

# 可选对象存储上传
S3_URL="${BACKUP_S3_URL:-}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ALIAS="${BACKUP_S3_ALIAS:-remote}"

log() { echo "[backup $(date -Iseconds)] $*"; }

# ---- 构造连接参数（统一用 --dbname=）----------------------------------
if [[ -n "$DB_URL" ]]; then
  CONN=(--dbname="$DB_URL")
  DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
else
  : "${PGHOST:?PGHOST 或 DATABASE_URL 必须提供其一}"
  : "${PGUSER:?PGUSER 必须提供}"
  : "${PGDATABASE:?PGDATABASE 必须提供}"
  CONN=(-h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -U "$PGUSER" --dbname="$PGDATABASE")
  DB_NAME="$PGDATABASE"
fi
DB_NAME="${DB_NAME:-sleep_monitor}"

# 给了 PGPASSWORD 则写临时 .pgpass，避免交互式口令提示
if [[ -n "${PGPASSWORD:-}" && -n "${PGHOST:-}" ]]; then
  export PGPASSFILE="${PGPASSFILE:-/tmp/.pgpass_bkp_$$}"
  printf '%s:%s:%s:%s:%s\n' "${PGHOST:-localhost}" "${PGPORT:-5432}" \
    "${PGDATABASE:-*}" "${PGUSER:-postgres}" "$PGPASSWORD" > "$PGPASSFILE"
  chmod 600 "$PGPASSFILE"
fi

# ---- 单实例锁 ----------------------------------------------------------
mkdir -p "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "已有备份进程在运行（锁被持有），本次退出。"
  exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_DIR}/${DB_NAME}-${TS}.dump"

log "开始逻辑备份 ${DB_NAME} -> ${DUMP_FILE}"
pg_dump --no-owner -Fc "${CONN[@]}" -f "$DUMP_FILE"
log "备份完成，大小 $(du -h "$DUMP_FILE" | cut -f1)"

# ---- 可选：上传对象存储 ------------------------------------------------
if [[ -n "$S3_URL" && -n "$S3_BUCKET" ]]; then
  if command -v aws >/dev/null 2>&1; then
    aws --endpoint-url "$S3_URL" s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/"
    log "已上传 s3://${S3_BUCKET}/$(basename "$DUMP_FILE")"
  elif command -v mc >/dev/null 2>&1; then
    mc cp "$DUMP_FILE" "${S3_ALIAS}/${S3_BUCKET}/"
    log "已上传 ${S3_ALIAS}/${S3_BUCKET}/$(basename "$DUMP_FILE")"
  else
    log "WARN: 配置了 BACKUP_S3_* 但 aws/mc 均不可用，跳过上传"
  fi
fi

# ---- 按保留期清理 ------------------------------------------------------
if [[ "${RETENTION_DAYS}" -gt 0 ]]; then
  log "清理 ${RETENTION_DAYS} 天前的 dump"
  find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.dump" -mtime "+${RETENTION_DAYS}" -delete
fi

log "备份流程结束 OK"
