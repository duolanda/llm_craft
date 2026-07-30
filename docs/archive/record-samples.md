# Phase 0 Record 样本选择

- 日期：2026-07-16
- 状态：旧格式兼容样本已选；当前规则样本待采集

## 结论

现有 `packages/server/logs/records/*.json` 中没有能够代表当前规则的可靠基线。当前实现是 144×96、无战争迷雾、包含 refinery、多格 footprint 和多 tick 施工；现有候选分别来自 21×21 和 96×64 旧规则。

因此下面两份记录只用于验证旧 `compact-v2` 的读取、回放和 analyzer 降级行为，不能用于当前平衡、Prompt 或模型能力结论。

## 旧短局兼容样本

文件：`packages/server/logs/records/match-2026-06-01T13-50-22-443Z.json`

- 79 ticks / 39.5 秒，player_1 获胜。
- 21×21 地图，只有 HQ、barracks、worker、soldier。
- `aiTurns = 1`，只有 player_2 的 4 次 model request / 3 次 tool call 可见；player_1 行为不能从 Agent trace 还原。
- player_2 连续产生 45 次 `build_invalid_position`，适合作为重复失败诊断与旧计划回放案例。
- T61 首次 HQ 掉血，T79 HQ 死亡，适合验证短时间线投影。

验证命令：

```bash
node packages/server/scripts/analyze-record.mjs packages/server/logs/records/match-2026-06-01T13-50-22-443Z.json --timeline
```

## 旧长局兼容样本

文件：`packages/server/logs/records/match-2026-06-18T01-01-44-369Z.json`

- 747 ticks / 373.5 秒，player_1 获胜。
- 96×64 地图，仍启用旧战争迷雾，没有 refinery 和当前施工语义。
- `aiTurns = 6`；player_1 有 63 次 model request / 97 次 tool call，player_2 无 Agent trace。
- analyzer 报告 player_1 `floating_credits` 和 `production_bottleneck_possible`，但规则和兵种统计均为旧版本，只能验证诊断管道，不应直接指导当前数值调整。
- T726 进入 HQ 五格压力范围，T729 首次掉血，T747 HQ 死亡，适合验证长时间线和关键 tick 对齐。

验证命令：

```bash
node packages/server/scripts/analyze-record.mjs packages/server/logs/records/match-2026-06-18T01-01-44-369Z.json --timeline
```

## 当前规则样本的采集要求

正式短局和长局基线必须来自真实 LLM 对局，并由同一个可记录的 MatchRuntime/现有兼容运行路径产生。CPU vs CPU 只用于确定性 smoke，不作为策略、模型或平衡样本。正式样本至少保存：

- 当前代码提交、地图和规则版本。
- 双方 LLM Controller、模型配置和 decision interval。
- 完整 command results、AI turns 和结束状态。
- 一份短局（快速形成生产和交战）与一份长局（至少覆盖扩张、多线推进和 HQ 压力时间线）。
- analyzer 输出与人工复盘说明；缺失字段必须列为 capability 缺失，不能按零处理。

真实 LLM 样本必须复用统一 MatchRuntime/MatchRecorder 路径，不为 strategic smoke 复制 record builder。上述两份兼容样本已列入 `packages/server/data/retention-pins.json`，不会被正式 artifact retention 当作普通旧文件清理。
