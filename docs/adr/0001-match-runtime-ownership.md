# ADR 0001：MatchRuntime 是对局生命周期的唯一所有者

- 状态：Accepted
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

当前 `Game` 同时持有规则推进、墙钟 timer、权威状态、历史记录和部分表现字段；`GameOrchestrator`、CLI control-plane 与 benchmark 又分别拥有调度循环。结果是 live、CLI 和 benchmark 的时钟、停止语义与保存能力不一致，也难以证明同一命令序列得到同一结果。

## 决策

引入以下边界：

- `MatchDefinition` 是冻结的开局输入，包含 ruleset、tick 时长、完整地图布局、玩家和胜利条件。
- `MatchRuntime` 是单局生命周期、模拟时钟、命令 tick 边界和终局通知的唯一所有者。
- `SimulationCore.step` 同步编排游戏规则阶段，不持有 timer，不调用模型，不发送网络消息，不写文件。
- `WorldState` 是唯一权威世界状态；Agent observation、客户端 frame 和 replay 都是只读投影。
- `MatchRegistry` 管理多个 MatchRuntime；WebSocket、HTTP 和 CLI 只能按 `matchId` 查找或操作对局，不能持有另一份对局状态。

## 所有权约束

| 能力 | 唯一所有者 |
|---|---|
| 对局开始、停止、结束 | MatchRuntime |
| 模拟 tick 推进 | MatchRuntime 调用 SimulationCore |
| 游戏规则与状态转移 | SimulationCore |
| 权威世界状态 | WorldState |
| 多对局查找 | MatchRegistry |
| 浏览器动画时钟 | Client Render Loop |

任何网络回调、模型 Promise、CLI 请求或文件写入都不得异步直接修改 WorldState。

## 当前结果

live、CLI/control 和 benchmark 都使用 MatchRuntime；模型与 CPU 调度订阅 committed tick，不再各自维护轮询 timer。`Game` 保留命令解释与游戏规则入口，`SimulationCore` 负责每 tick 的确定性阶段编排。

## 明确不做

- Phase 1 不改变 500ms live 步长和现有玩法数值。
- 不一次性重写寻路、战斗、经济和渲染。
- 不把 MatchRuntime 变成新的全能类；规则必须留在 SimulationCore，协议和投影必须留在各自边界。

## 影响

短期会增加 adapter 和迁移代码；长期可以无墙钟推进测试、复现对局，并让 live、CLI、benchmark 和 replay 共享生命周期语义。
