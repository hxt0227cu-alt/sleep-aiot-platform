# ADR-018: 数据库韧性 —— 逻辑备份 / 恢复与 PITR 策略

## Status
Accepted

## Context

生产就绪度评估（`04`/`05`）把「数据库零备份 / 无 PITR」列为**阻塞级**缺口：

- 平台层 grep `pgBackRest|wal-g|WAL|backup|pg_dump|pitr` 仅命中 `platform/data/dbt/`（数据仓库），主业务 PG 没有任何备份方案。
- 一次 `DROP` / 误迁移 = 全部健康数据不可逆丢失，RPO 实际为「自上次手动导出以来」。
- `backend-ci.yml:79` 用 `prisma db push` 而非迁移文件，进一步放大 schema 漂移风险。

评估同时指出，四大运行时保障（备份、多租户、合规、可观测性）至今「没有任何一份 ADR 之外可运行的证据」。本 ADR 把备份从纸面拉到**可运行 + CI 门禁**，并明确 PITR 为后续项。

## Decision

1. **自动化逻辑全量备份（现在就做，可验证）**
   - `backup.sh`：`pg_dump -Fc`（custom format，压缩），单实例 `flock`、按保留期清理、可选上传对象存储（S3/MinIO）。
   - `restore.sh`：`pg_restore -l` 预检 → `--clean --if-exists --no-owner` 恢复 → 表数量健全性检查。
   - `verify-restore.sh`：恢复到**临时库**并断言，用于定期恢复演练（证明 dump 真的可恢复）。
   - K8s：`postgres-backup-configmap.yaml`（挂脚本）+ `postgres-backup-pvc.yaml`（落盘）+ `postgres-backup-cronjob.yaml`（每日 02:00 Asia/Shanghai，`concurrencyPolicy: Forbid`）。CronJob 复用与 PG 服务端对齐的 `timescale/timescaledb:2.17.2-pg16` 镜像（含 `pg_dump`/`pg_restore`），避免引入 `:latest`。

2. **CI 真实验证备份/恢复机制（现在就做，可运行证据）**
   - `backend/src/database/backup-restore.integration.spec.ts`：在 `DATABASE_URL` + `pg_dump`/`pg_restore` 可用时，做「建表→`pg_dump` 全库→删表→`pg_restore`→断言数据完整恢复」的真实往返；工具/实例缺失则 `describe.skip`（本地不报红），由 CI 的 TimescaleDB service container + `postgresql-client` 真正执行。

3. **PITR（时间点恢复）作为 Phase 2 独立变更（明确 deferred）**
   - 真正 PITR（RPO 降到秒级）需要 **WAL 归档 + 基础备份**，建议用 `wal-g` 或 `pgBackRest`（专用镜像，客户端与服务端版本对齐）。本 ADR 不把它当作本次交付，避免在没有演练的情况下声称「已具备 PITR」。

4. **迁移方式：从 `db push` 改为版本化迁移文件（Phase 2 协同）**
   - `prisma db push` 不利于回滚与审计；应在 Phase 2 引入 `prisma migrate`，与备份策略配套。

## Consequences

- **变容易**：备份可重复、可审计；灾难恢复演练可执行；CI 证明「备份/恢复机制」真实成立（不再是纸面 ADR）。
- **变困难 / 付出的代价**：
  - 备份存储成本（每日 dump × 保留期）；对象存储上传为可选项。
  - 恢复流程必须**定期演练**才能算「具备韧性」——光有备份文件不等于能恢复（故提供 `verify-restore.sh` 并建议定时运行）。
  - PITR（RPO 秒级）本次**未做**，RPO 实际 ≈ 备份周期（默认每日一次 = 最多丢一天）。这是为「先有可验证的基线」而**主动接受**的权衡，而非忽略。
- **RPO 改善**：从「未定义 / 自上次手动导出」提升到「≤ 备份间隔」；PITR 落地后进一步降到秒级。
- **治理一致性**：与 ADR-014/016/017 同属「把设计变成可运行证据」主线；CI 门禁模式与 Redis 扇出 / EMQX 共享订阅集成测试一致。

## 后续项

- Phase 2：引入 WAL 归档 + `wal-g`/`pgBackRest` 实现 PITR；并做首次真实 PITR 恢复演练。
- Phase 2：迁移 `prisma db push` → `prisma migrate` 版本化文件，消除 schema 漂移。
- 运维：创建 Secret `postgres-backup-secret`（`POSTGRES_HOST/PORT/USER/PASSWORD/DB`）；定时运行 `verify-restore.sh` 校验 dump 可用性。
- 监控：备份 CronJob 失败告警（FailedJobs）+ 备份文件存在性与新鲜度检查。
