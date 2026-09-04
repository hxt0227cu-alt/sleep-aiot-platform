# 智能睡眠监测台灯数据库设计说明

## 文档定位

本文说明数据库设计意图、权威来源和运维边界，不再手工复制全部表字段。手工字段清单会随 Prisma 模型和迁移演进而失真，不得作为建库或迁移输入。

当前证据仅来自仓库源码和 SQL 静态核查；未对 staging 或生产数据库执行 introspection。

## 期望状态与观测状态

数据库不存在一个覆盖所有对象的单一文件，必须按职责读取：

| 层次 | 路径 | 职责 |
| --- | --- | --- |
| 应用访问模型 | `backend/prisma/schema.prisma` | Prisma ORM 模型、关系、索引和表名映射 |
| 演进历史 | `backend/prisma/migrations/` | SQL 迁移与数据库演进记录；包含 Prisma 模型尚未覆盖的对象 |
| TimescaleDB 扩展对象 | `backend/prisma/setup-timescaledb.sql`、`backend/prisma/migrations/init_timescaledb.sql` | 超表、连续聚合、保留/压缩/刷新策略及相关函数 |
| 部署后观测 | 数据库 introspection | 仅用于检测实际库与期望状态的漂移，不是反向合理化未审批变更的权威来源 |

Prisma 模型必须与迁移定义兼容，但 Prisma 不覆盖全部数据库对象。例如 `20260000000000_baseline/migration.sql` 创建的 `agent_runtime_runs`、`agent_preference_memories`、`agent_workspace_artifacts` 和 `agent_memory_audit` 当前不在 `schema.prisma` 中。

## 核心设计原则

- PostgreSQL/TimescaleDB 承载事务数据、用户与设备关系、健康数据、审计和 Agent 运行状态。
- 所有包含租户数据的读写必须显式携带并校验 `tenant_id`；健康数据按敏感个人信息处理。
- 数据结构变更通过可审计迁移演进，不在生产环境使用 `prisma db push` 代替迁移审核。
- 迁移采用向前兼容或可回滚策略；破坏性变更使用 expand/contract。
- 时间使用带时区的时间戳或明确单位的 epoch；传感器值必须明确单位与精度。
- 备份、恢复和漂移检测属于发布门禁，不能用“脚本存在”代替真实恢复验证。

## 应用模型

应用表和字段以 `backend/prisma/schema.prisma` 为准。常见领域包括：

- 用户、认证会话、验证码、登录审计和用户设置；
- 租户、成员、配额和审计事件；
- 设备、绑定、配置、命令、固件和光闹钟；
- 睡眠计划、日记、报告、体征、睡眠状态和报警；
- 知识文档、Agent Run、算法提案和 Outbox。

不要在本文维护字段镜像。评审具体字段时直接引用 Prisma model 名称和迁移文件；引用代码时优先使用符号名而非易漂移的行号。

## TimescaleDB 当前声明

仓库 SQL 静态声明了两张超表：

- `vital_signs_data`
- `sleep_state_data`

两张表均声明 90 天原始数据保留和 7 天后压缩。连续聚合使用：

- `vital_signs_1m`
- `vital_signs_5m`
- `vital_signs_1h`

`setup-timescaledb.sql` 为这些聚合声明 365 天保留；`init_timescaledb.sql` 还包含刷新策略、附加索引、函数和触发器。上述内容是仓库期望状态的静态证据，不代表目标环境已经实际应用。

### 未决：TimescaleDB 正式入口

当前同时存在：

1. `backend/prisma/setup-timescaledb.sql`
2. `backend/prisma/migrations/init_timescaledb.sql`

两者并不等价，仓库文档也分别引用了它们。在 owner 完成 Compose、CI、Kubernetes/Helm 和人工部署入口清点前，不得擅自合并、删除或宣称其中一份为唯一权威。决策完成后应新增或更新 ADR，并提供空库初始化与升级路径验证。

## 环境数据库名称

- 本地历史开发文档通常使用 `sleep_lamp`。
- ECS/preprod 文档和活动 Compose 通常使用 `sleep_monitor` 或环境变量 `POSTGRES_DB`。

数据库名是环境配置，不是应用契约。运行 `psql`、备份、恢复或迁移前必须确认 `DATABASE_URL`/`POSTGRES_DB` 指向的环境，禁止把某个环境名称硬编码为全局默认事实。

## 索引与查询

- 索引必须由实际查询路径和执行计划驱动，避免在文档中凭空声明。
- 控制面优先经 Prisma 访问事务表；TimescaleDB 扩展对象由受审 SQL 管理。
- Redis key 或限流 key 中涉及请求路径时，当前 API 前缀为 `/api`，例如 `rate_limit:user_001:/api/devices`。
- 连续聚合是否保留，应以真实读方清点和容量/成本证据决定；当前应用仍存在直接读取原始体征表的路径。

## 安全与数据治理

- 睡眠、心率、呼吸率、体动和行为数据按敏感健康数据处理。
- 最小采集、最小可见、租户隔离、访问审计、留存和删除要求必须落实到运行路径。
- 数据库连接串和密码只从环境变量或密钥管理注入，不写入文档、源码或 Compose 默认值。
- 迁移和备份任务使用最小权限账户；恢复验证必须在隔离数据库中执行。

## 变更与验证

数据库变更至少需要：

1. 更新期望状态文件并说明兼容/回滚策略；
2. 检查 Prisma 与迁移兼容性；
3. 在隔离数据库执行空库初始化和从上一版本升级；
4. 对 TimescaleDB 对象执行存在性、策略和查询 smoke test；
5. 执行备份恢复往返验证；
6. 对多租户和健康数据执行双租户负向测试；
7. 将实际结果和未验证风险记录到项目变更日志（内部变更记录不随公开仓库分发）。

未经上述运行验证，只能表述为“静态定义已更新”，不得声称数据库部署完成。
