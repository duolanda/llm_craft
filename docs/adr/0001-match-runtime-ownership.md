# ADR 0001：MatchRuntime 是对局生命周期的唯一所有者

- 状态：Accepted
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

当前 `Game` 同时持有规则推进、墙钟 timer、权威状态、历史记录和部分表现字段；`GameOrchestrator`、CLI control-plane 与 benchmark 又分别拥有调度循环。结果是 live、CLI 和 benchmark 的时钟、停止语义与保存能力不一致，也难以证明同一命令序列得到同一结果。

## 决策

引入以下边界：

- `MatchDefinition` 是开局输入，包含 ruleset、scenario、地图、seed、玩家和胜利条件；创建对局后不可被运行中逻辑隐式修改。
- `MatchRuntime` 是单局生命周期、模拟时钟、控制器调度、命令调度和 journal 协调的唯一所有者。
- `SimulationCore.step` 只根据前一状态、当前 tick 输入和 seeded RNG 计算下一状态及 DomainEvent，不持有 timer，不调用模型，不发送网络消息，不写文件。
- `WorldState` 是唯一权威世界状态；Agent observation、客户端 frame、metrics 和 replay 都是版本化投影。
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

## 迁移顺序

1. 用表征测试和 state hash 固定当前可接受行为。
2. 从 `Game.tickUpdate()` 提取同步 step，同时保留兼容 adapter。
3. 先让 live 路径使用 MatchRuntime，再迁移 CLI/control-plane，最后迁移 benchmark。
4. 每迁移一条路径就删除对应旧 timer 和生命周期所有权，不长期双写。

## 明确不做

- Phase 1 不改变 500ms live 步长和现有玩法数值。
- 不一次性重写寻路、战斗、经济和渲染。
- 不把 MatchRuntime 变成新的全能类；规则必须留在 SimulationCore，协议和投影必须留在各自边界。

## 影响

短期会增加 adapter 和迁移代码；长期可以无墙钟推进测试、复现对局，并让 live、CLI、benchmark 和 replay 共享生命周期语义。

## 实施进度

- 2026-07-16：引入 `MatchRuntime` 与可替换 `ClockDriver`；500ms timer 已从 `Game` 移出，live 和 CLI/control-plane 均通过 MatchRuntime 推进。
- 2026-07-16：引入首版不可变 `MatchDefinition`，Game 初始化和 runtime clock 已从同一份定义读取。当前刻意只接受默认 ruleset/scenario/地图几何，因为 agent prompt 尚未改为按定义生成；Controller/plan scheduler 与完整 SimulationCore 迁移仍未完成。
- 2026-07-16：首版同步 `SimulationCore.step()` 已接管 live 的实际规则阶段编排；wall-clock/performance instrumentation 留在 MatchRuntime。
- 2026-07-16：引入首版 `WorldState` 聚合 tick、entity registries、玩家经济、地图资源、弹丸和胜负状态；Player 实体集合改为 registry 投影。step 使用 checkpoint/rollback 保证异常原子性并 fail-stop。统一跨类型实体身份、DomainEvent、版本化投影以及将剩余规则方法移出 Game 尚未完成。
- 2026-07-16：新增跨 Unit/Building 的 `EntityRegistry`，统一 target ID 解析、live/destroyed 过滤和 tick 末实体不变量；attack/projectile 已迁入该入口。创建、销毁和引用失效仍需从两个 manager 继续收口，尚未宣告实体生命周期迁移完成。
- 2026-07-16：生产路径的 entity 创建/销毁已收口到 WorldState/EntityRegistry；权威 WorldUnit 使用 `order`，Player/GameState 才投影为兼容 `intent`，且不再泄露可变实体引用。WorldState revision 同时替代 GameAgentBridge 不安全的 tick-only 缓存失效条件。
- 2026-07-16：Movement、Projectile、Economy、HarvestOrder、Combat、Construction、Production、Victory 已提取为无 I/O 的 simulation systems。SimulationCore 现在直接接收 WorldState、组合唯一规则顺序并输出结构化 outcome，Game 中的 `processXPhase()` 反向调用已删除。Game 仍作为旧 command 与日志 adapter，后续由 CommandGateway / DomainEvent 取代。
- 2026-07-16：MatchDefinition.seed 已绑定到 WorldState 专属的可序列化 `mulberry32-v1` RNG；状态纳入 checkpoint 与 hash。正式创建/销毁路径同时收口到 EntityRegistry / WorldState，Manager 降为存储细节。
- 2026-07-16：`MatchRegistry` 已替代 `ServerState` 中单一 orchestrator/control match 字段；live、control 和每个 benchmark round 都以稳定 `matchId` 注册。HTTP、CLI 与 WebSocket 只通过 registry 查询/选择，观察切换与停止/保存生命周期解耦。
