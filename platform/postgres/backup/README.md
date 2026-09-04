# PostgreSQL 逻辑备份 / 恢复

> 对应 ADR-018。解决生产就绪度评估（04/05）中「数据库零备份 / 无 PITR」这一阻塞级缺口。

## 组件

| 文件 | 作用 |
| --- | --- |
| `backup.sh` | 逻辑全量备份：`pg_dump -Fc`，可选上传对象存储 + 按保留期清理 + 单实例锁 |
| `restore.sh` | 逻辑恢复：`pg_restore -l` 预检 → `--clean --if-exists --no-owner` 恢复 → 表数量健全性检查 |
| `verify-restore.sh` | 恢复演练：恢复到**临时库**并断言，验证 dump 可恢复（用于定期完整性校验）|

## 认证

优先使用 `DATABASE_URL`（连接串）。若用 libpq 环境变量（`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`），
脚本会写临时 `.pgpass` 避免交互式口令提示。容器里通过 Secret 注入这些变量。

## 本地试跑（需本地有 postgres 客户端 + 服务端）

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sleep_monitor
BACKUP_DIR=/tmp/bkp ./backup.sh
./restore.sh /tmp/bkp/<file>.dump            # 恢复到原库
./verify-restore.sh /tmp/bkp/<file>.dump    # 恢复到临时库并断言
```

## K8s 接线

- `platform/k8s/base/postgres-backup-configmap.yaml`：把上面三个脚本挂成 ConfigMap（`/scripts`）。
- `platform/k8s/base/postgres-backup-pvc.yaml`：备份落盘卷。
- `platform/k8s/base/postgres-backup-cronjob.yaml`：每日 02:00（Asia/Shanghai）跑 `backup.sh`。
- CronJob 引用 Secret `postgres-backup-secret`（由运维创建），需含：
  `POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB`。

## PITR（时间点恢复）— 后续项

当前为**逻辑全量备份**，RPO ≈ 备份周期（默认每日一次 = 最多丢一天）。
真正的 PITR（RPO 降到秒级）需要 **WAL 归档 + 基础备份**，建议用 `wal-g` 或 `pgBackRest`
（专用镜像，客户端与服务端版本对齐），作为 ADR-018 的 Phase 2 独立变更。
同时应把 `prisma db push` 改为版本化迁移文件（`prisma migrate dev`），消除 schema 漂移。
