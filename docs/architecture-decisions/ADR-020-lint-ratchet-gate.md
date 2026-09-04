# ADR-020: 用棘轮门禁替代永远失败的 lint 步骤

## Status
Accepted

## Context

`.github/workflows/backend-ci.yml` 的 `test` job 步骤顺序是：

```
Run linter → Run type check → Run tests → Build
```

而 `pnpm run lint` 在存量代码上的实际结果是 **2246 个 error，分布在 107 个文件**。也就是说这一步从仓库第一天起就是失败的，它后面的类型检查、单元测试、构建**从来没有执行过**。

连锁后果比"代码风格不统一"严重得多：

- `build-and-push` 的 `needs: [test, ...]` 永远不满足 → 镜像构建、SBOM、cosign 签名、staging 部署全部是死代码。
- 前几轮为 ADR-014/016/017/018/019 加的所有验证（Redis 扇出集成测试、EMQX 共享订阅、备份/恢复往返、promtool 告警校验）全都挂在这一步下游。**给一条从不运行的流水线加门禁，等于什么都没加。**

这是本仓库里最典型、也是危害最大的一处"假门禁"：它看起来是治理，实际是装饰。

错误分布（自动修复前）：`prettier/prettier` 995、`no-unsafe-member-access` 706、`no-unsafe-assignment` 330，其余为 `no-unsafe-return` / `no-unused-vars` / `require-await` 等。近半是纯格式问题，另一半是 `any` 蔓延带来的类型安全债务。

## Decision

分两步，机械问题彻底解决，类型债务冻结后逐步偿还。

### 第一步：把能自动修复的全部修掉

对 `backend` 全量运行 `eslint --fix`：**2246 → 1232 error，107 → 78 个文件**。995 个 prettier 错误清零。修复后 `tsc --noEmit` 退出码 0、101 个单测全通过，确认这一步是零行为风险的。

### 第二步：本轮及历轮由架构改造引入的文件，全部清到零

范围：`observability/` `redis/` `tenant/` `database/` 等前几轮 ADR 落地时新增的文件，共 96 个残留错误 → **0**。过程中顺带做了几处不只是"消 lint"的实质改进：

- `FanoutEnvelope.data` / `LocalBroadcast.message.data` 由 `any` 收紧为 `unknown`。扇出层只做 JSON 透传、从不读取内容，`unknown` 能在编译期阻止"顺手在扇出层解读业务字段"的越界耦合，且对调用方零影响。
- `tenant-scope.ts` 的 `Record<string, any>` 收紧为 `Record<string, unknown>`，并引入 `asRecord()` 收敛函数。这修掉了一个**真实的静默故障**：`{ ...'oops' }` 在 JS 里会展开成 `{0:'o',1:'o',2:'p',3:'s'}`，一旦调用方误把标量传给 `where`，就会构造出语法合法、语义完全错误的查询条件而不报任何错。已补回归测试。
- `InfraMetricsSink` 的成员由方法语法改为「属性 + 箭头类型」。方法语法的参数是双变的（bivariant），会放过不安全的实现；属性语法在 `strictFunctionTypes` 下按逆变严格检查。对这种会被替换实现、被解构传递的出口契约，严格检查更有价值（同时根除了 7 处 `unbound-method`）。
- `'PubSubBroker'` / `'DistributedLock'` 字符串令牌统一为 `PUB_SUB_BROKER` / `DISTRIBUTED_LOCK` 常量，与 ADR-019 引入的 `INFRA_METRICS_SINK` 保持一致。

### 第三步：剩余 1133 个存量错误用棘轮冻结，而不是硬改或关规则

`backend/scripts/lint-ratchet.cjs` + `backend/lint-baseline.json`：

- 每个存量文件记录当前错误数作为基线（67 个文件 / 1133 个错误）。
- **不在基线里的文件（= 新文件）必须零错误。**
- 在基线里的文件，错误数**只能减少，不能增加**。
- `--update` 只允许往下更新：若发现某文件错误数变多或存在未清零的新文件，直接失败退出。**没人能靠"重新生成基线"把新债务洗白。**

CI 的 `Run linter` 改为 `pnpm run lint:ci`（即棘轮），`pnpm run lint` 保留为开发者查看完整清单用。

考虑过但否掉的两个方案：

| 方案 | 否掉的理由 |
|---|---|
| 花几周把 1133 个错误全改完 | 需要大范围触碰 `sleep.service.ts`(120)、`device-message-handler`(84) 等**几乎没有测试覆盖**的核心业务代码。改错的风险远大于收益，且整个期间门禁依然是红的。 |
| 把 `no-unsafe-*` 全部降级为 warn | 等于永久放弃类型安全。新代码会继续以同样速度制造债务，只是不再可见——这是把假门禁换成了假绿灯。 |

## Consequences

- **变容易**：CI 今天就是绿的，而且是**真绿**——`tsc`、单测、构建、镜像签名、部署终于会真正执行，前几轮加的所有验证第一次开始生效。本地按 CI 顺序完整重放：棘轮通过 → tsc 退出码 0 → 102 个测试通过 → `nest build` 成功。新代码被完整强制到最严标准。
- **变困难 / 付出的代价**：
  - 存量文件里的 1133 个错误**今天不会被修**，且债务清单是长期可见的（这是刻意的：可见的债务才会被偿还）。
  - 棘轮是**文件粒度**，同一文件内"修好一个、新引入一个"的对冲不会被发现。若将来需要更细粒度，可改为按 `rule × file` 计数，代价是基线文件体积与维护成本上升。
  - 存量文件的重命名会被当作新文件，要求零错误。这在语义上是对的（重命名通常伴随重构），但会让大规模挪动文件的成本变高。
  - 若开发者本机与 CI 的 lint 结果因环境差异不一致，门禁会误报。已用 `prettier` 的 `endOfLine: "auto"` 消除换行符差异，类型感知规则依赖同一份 tsconfig 与锁定的依赖版本，风险可控；真出现差异时脚本输出会精确指出是哪个文件、从几变到几。
- **债务可度量**：`pnpm run lint:ci` 每次都会打印"当前 X / 基线 Y"，偿还进度是一个可以被跟踪的数字，而不是模糊的"技术债很多"。

## 后续项

- 按文件的错误密度排序逐步偿还，优先级建议：先补测试再改类型，顺序为 `websocket.service.ts`(66) → `device-message-handler.service.ts`(84) → `sleep.service.ts`(120)。每清完一个文件运行 `pnpm run lint:baseline` 锁定成果。
- 其余两条 workflow（`enterprise-platform-ci.yml`、`miniprogram-ci.yml`）尚未核查是否存在同类假门禁，需要同样的排查。
- 待存量债务清零后，删除棘轮脚本与基线文件，`lint:ci` 直接回退为 `lint`。
