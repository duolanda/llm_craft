# Phase 0 基线记录

- 状态：进行中
- 基线日期：2026-07-16
- Git 基准提交：`c8c7290`（采集时工作树包含未提交改动，最终基线应以合入提交替换）
- Roadmap：[docs/roadmap.md](../roadmap.md)

## Strategic smoke 回归与修复证据

修复前，`strategic-scale-smoke.ts` 在 360 tick 的结果为：

- 双方 `barracks / refinery / war_factory = 0`
- `peakCombinedCombatUnits = 0`
- `peakActiveFronts = 0`
- 失败：`Expected at least 40 combined combat units, got 0`

根因包括：内置 CPU 没有先把 builder 移到建筑 footprint 邻格；经济命令会覆盖 builder 移动；施工中建筑被当作已完成产能；生产持续消耗科技建筑预算；前线矿工使用错误的固定资源索引。

修复后的固定 360 tick smoke 基线为：

- 双方均曾建立至少 `1 barracks + 1 refinery + 1 war_factory`
- `peakCombinedCombatUnits = 47`
- `peakActiveFronts = 3`（按 attack/attack-move 的目标战线统计）
- `commandFailureCounts = {}`
- 40 / 80 / 160 单位压力段全部保留 group attack-move intent

运行方式：

```bash
pnpm --filter @llmcraft/server smoke:strategic
```

正式包的本地依赖已经统一为 `workspace:*`；新增 `@llmcraft/trace` 位于 shared 与 server/client 之间。`packages/audit-report` 已按现有 `packages/*` 规则正式纳入 workspace lockfile，`sharp` / `workerd` 的安装脚本许可也已显式配置；根级验证可直接运行：

```bash
pnpm verify
```

`slowestTickMs` 受开发机负载影响，不在本基线中锁定为固定值。

## 自动化护栏

- `BuiltinCPUStrategy.test.ts`：红蓝双方都必须先移动 builder，并在 80 tick 内完成 barracks。
- `GameDeterminism.test.ts`：固定移动、建造、生产和推进命令运行 40 tick；两次运行的逐 tick 权威状态 hash 必须完全一致。
- 权威 hash 排除 UI/AI log；观察者字段 `my` 已从 Unit/Building 类型删除。hash schema v2 将可序列化 RNG 状态也纳入权威状态，因为它决定下一次随机转移；当前最终 hash：`ae3e3e12e33bea6cfc5411cdf298f7ebffb07644952df0642f0c0ca4811fd30b`。旧 v1 hash `5c3d134a…190c288` 仅因 hash schema 扩展而替换，本次规则行为未变。

## 当前验证结果

- 服务端 TypeScript：通过。
- 服务端完整测试：通过，`23` 个测试文件、`224` 项测试全部通过。
- strategic smoke：通过。
- shared、trace、server、client、CLI 的逐包 typecheck/build：全部通过；client 仅有既存的主 chunk 大于 500 kB 警告。
- 根级 `pnpm verify`：通过（shared/trace/server/client/CLI typecheck，server 全测与 build，client/CLI build）；client 仅保留既存的主 chunk 大于 500 kB 警告。

## 尚未完成的 Phase 0 基线

- 已选两份旧格式短局/长局作为兼容样本并完成分析；它们不代表当前规则，详见 [record-samples.md](record-samples.md)。
- Record、Transcript、Analyzer、Diagnostics 的能力缺口已落盘，详见 [tooling-capability-audit.md](tooling-capability-audit.md)。
- 仍需通过正式记录路径采集当前 144×96 规则的短局、长局与配套人工复盘。
- 将工作树基准替换为可复现的最终提交标识。
