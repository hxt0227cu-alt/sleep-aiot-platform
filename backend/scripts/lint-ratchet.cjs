#!/usr/bin/env node
/**
 * Lint 棘轮门禁（ADR-020）。
 *
 * 问题：`pnpm run lint` 在存量代码上有 1000+ 个 type-safety error（`any` 蔓延），
 * 于是 CI 的 "Run linter" 步骤从第一天起就是红的。红了就没人看，没人看就等于
 * 没有门禁 —— 更糟的是，它挂在 `test` job 里，导致整条流水线（包括后面的
 * 构建、镜像签名、部署）从来没有真正跑通过。这属于典型的"假门禁"。
 *
 * 两条路都不可取：
 *   a) 花几周把 1000+ 个错误全改完 —— 大范围触碰未被测试覆盖的业务代码，
 *      风险远大于收益，且期间门禁依然是红的。
 *   b) 把规则关掉 —— 等于永久放弃类型安全，新代码会继续制造同样的债务。
 *
 * 采用第三条：棘轮（ratchet）。
 *   - 为每个存量文件记录当前错误数作为基线（lint-baseline.json）。
 *   - 任何**不在基线里的文件**（= 新文件）必须零错误。
 *   - 任何在基线里的文件，错误数**只能减少，不能增加**。
 *   - 基线只能往下更新：`--update` 若发现某文件错误数变多，会直接失败，
 *     防止有人靠"重新生成基线"把新债务洗白。
 *
 * 效果：门禁今天就是绿的（真门禁，下游步骤终于会执行），新代码被完整强制，
 * 存量债务被冻结并可以逐步偿还。
 *
 * 放弃了什么：存量文件里的错误今天不会被修复，且同一文件内"修好一个、
 * 新引入一个"的对冲不会被发现（文件粒度而非行粒度）。若将来需要更细的粒度，
 * 可以改成按 rule+file 计数，代价是基线文件体积和维护成本上升。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'lint-baseline.json');
const GLOB = '{src,apps,libs,test}/**/*.ts';
const UPDATE = process.argv.includes('--update');

/**
 * 用 ESLint 的 Node API 而不是子进程调用 CLI。
 * 原因：Windows 上 execFileSync 执行不了 npx 的 .cmd 包装器（EINVAL），
 * 而 ESLint 9 又不再从 package exports 暴露 bin 入口。Node API 跨平台且免解析。
 */
async function collect() {
  const { ESLint } = require('eslint');
  const eslint = new ESLint({ cwd: ROOT });
  const report = await eslint.lintFiles([GLOB]);
  const counts = {};
  for (const file of report) {
    if (file.errorCount === 0) continue;
    const rel = path.relative(ROOT, file.filePath).split(path.sep).join('/');
    counts[rel] = file.errorCount;
  }
  return counts;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return {};
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files ?? {};
}

function writeBaseline(counts) {
  const files = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
  const total = Object.values(files).reduce((s, n) => s + n, 0);
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        _comment:
          '存量 lint 债务基线（ADR-020）。每个文件的错误数只能下降。新文件必须为 0，因此不得手工添加条目。',
        generatedAt: new Date().toISOString(),
        totalErrors: total,
        files,
      },
      null,
      2,
    ) + '\n',
  );
  return total;
}

async function main() {
  const current = await collect();
  const baseline = readBaseline();

  const regressions = [];
  const newFiles = [];
  const improvements = [];

  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file];
    if (allowed === undefined) {
      newFiles.push({ file, count });
    } else if (count > allowed) {
      regressions.push({ file, count, allowed });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = current[file] ?? 0;
    if (count < allowed) improvements.push({ file, count, allowed });
  }

  const currentTotal = Object.values(current).reduce((s, n) => s + n, 0);
  const baselineTotal = Object.values(baseline).reduce((s, n) => s + n, 0);

  if (UPDATE) {
    // 引导：基线文件还不存在时，把当前状态原样记录为起点。
    // 之后再运行 --update 就会走下面的严格分支，只允许下降。
    if (!fs.existsSync(BASELINE)) {
      const total = writeBaseline(current);
      console.log(
        `已建立初始基线：${Object.keys(current).length} 个文件，共 ${total} 个存量错误。`,
      );
      return;
    }
    if (regressions.length || newFiles.length) {
      console.error(
        '拒绝更新基线：以下文件的错误数增加了或是未清零的新文件。基线只能往下走。',
      );
      for (const r of regressions) {
        console.error(`  ${r.file}: ${r.allowed} -> ${r.count}`);
      }
      for (const n of newFiles) {
        console.error(`  ${n.file}: 新文件，必须为 0，实际 ${n.count}`);
      }
      process.exit(1);
    }
    const total = writeBaseline(current);
    console.log(
      `基线已更新：${Object.keys(current).length} 个文件，共 ${total} 个存量错误` +
        (baselineTotal ? `（此前 ${baselineTotal}）` : ''),
    );
    process.exit(0);
  }

  let failed = false;

  if (newFiles.length) {
    failed = true;
    console.error('\n新增/未登记文件必须零 lint 错误：');
    for (const n of newFiles) console.error(`  ${n.file}  ${n.count} 个错误`);
  }

  if (regressions.length) {
    failed = true;
    console.error('\n存量文件的 lint 错误数不允许增加：');
    for (const r of regressions) {
      console.error(`  ${r.file}  ${r.allowed} -> ${r.count}`);
    }
  }

  if (improvements.length) {
    console.log('\n以下文件的债务已减少，运行 `pnpm run lint:baseline` 锁定成果：');
    for (const i of improvements) {
      console.log(`  ${i.file}  ${i.allowed} -> ${i.count}`);
    }
  }

  console.log(
    `\nlint 债务：当前 ${currentTotal} / 基线 ${baselineTotal}（文件数 ${Object.keys(current).length}）`,
  );

  if (failed) {
    console.error('\n棘轮门禁未通过。');
    process.exit(1);
  }
  console.log('棘轮门禁通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
