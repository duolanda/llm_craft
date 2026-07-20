# LLMCraft 当前实现现状

日期：2026-07-20

> 文件名为历史遗留；本文描述当前实现，不使用 MVP 阶段假设。

## 1. 运行边界

- `MatchRuntime` 拥有单局时钟、500ms tick、`CommandGateway` 和结束通知。
- `SimulationCore` 同步编排 movement → projectiles → economy → harvest → combat → construction → production → victory。
- `Game` 负责解释命令、持有 `WorldState`、执行规则并生成 UI/AI feedback log。
- SimulationCore 异常会停止该局；不会克隆世界、回滚 tick 或继续运行半失败对局。
- 命令在下一 tick 边界释放。每条命令独立执行，一条失败不会撤销同批次的其他成功命令。
- 没有每 actor 每 tick 命令上限、全局路径命令额度或阻塞重寻路额度。

## 2. 对局与玩家控制

生命周期控制和玩法控制是两个边界：

- 生命周期：`MatchRegistry + MatchRuntime`，由 WebSocket、HTTP 或 CLI 触发创建、预热、开始、停止、查询和观察。
- 玩法：`GameplayController`，供 AgentRuntime、CLI adapter 和 built-in CPU 使用同一套观察/动作工具。
- `DecisionController` 是可由 harness 调度的决策来源；当前实现为 LLM 和 built-in CPU。
- `GameOrchestrator` 订阅 committed tick。某方空闲且遇到新 tick 时可开始下一次决策；慢方仍运行时只跳过慢方，不阻塞快方。
- 不存在 100ms AI poll 或固定 5 tick 宏观决策间隔。
- `warmup` 只提前执行选中模型的首个真实请求并保留会话结果，不启动游戏时间。

普通 live 流程只允许一个 active match。重复 start 返回提示。`llmcraft play` 重复调用只返回已有 active control match 的信息，不创建新对局或 session。benchmark round 仍可并行注册；前端的对局面板可以切换观察任一 registry entry。

## 3. MatchDefinition

当前定义由以下内容组成：

- `map`：地图 ID、144x96 尺寸、矿脉、障碍物、双方 HQ 和初始单位位置；
- `players`：两个玩家槽位和初始 credits；
- `rulesetId`、`tickIntervalMs` 和胜利条件。

当前只接受内置 `standard` ruleset 和 `standard` map 的完整布局。命令限制、模型调度和记录配置不属于 MatchDefinition。

shared constants 是内置 `standard` 规则和地图模板的定义处；`createDefaultMatchDefinition()` 会把地图布局复制进单局定义。运行中的地图尺寸、矿脉、障碍物、开局实体和 tick 时长读取该局 MatchDefinition；单位数值、造价和生产关系通过其 `rulesetId` 对应的 shared ruleset helper 读取。前者是“这一局采用什么”，后者是“内置 standard 具体是什么”，不是两套相互竞争的配置。

## 4. Agent runtime

- 模型通过 OpenAI-compatible tool calling 观察和控制游戏，不生成可执行 JavaScript。
- 只读工具：`get_map_state`、`get_my_state`、`get_my_units`、`get_army_summary`、`get_active_plans`、`get_recent_events`。
- 动作工具：移动、attack move、group attack move、指定目标攻击、生产、建造、持续采矿和 hold。
- `orchestrate_plan` 注册多步 Mission；`GameplayController.handleCommittedTick()` 在 committed tick 通知上推进 Mission 和持续攻击。
- group attack move 会一次提交所有编队命令，不做跨 tick pending group release。
- 同 tick 多个付费 plan 会按当前可用 credits 预留成本；这里的约束是游戏货币可用性，不是命令执行额度。
- `ContextWindowLimiter` 暂时按消息数和字节裁剪 provider history。它不是持久 memory，也不是真正的语义 compactor。

## 5. CLI / HTTP control

- `POST /api/control/start-game` 创建 control match；已有 active control match 时返回该 `matchId` 和 `reused: true`。
- control session 固定绑定 `matchId + playerId`，观察对象变化不会迁移 session。
- 单 tool 请求直接进入绑定玩家的 `GameplayController`。
- `/sessions/:id/actions` 接受带 `clientRequestId` 的 action 数组并提供请求级幂等；每个 action 独立执行和返回。部分失败时保留成功动作并返回 `partialSuccess: true`。
- MatchRegistry HTTP API 支持列表、切换观察、停止和保存指定对局。

## 6. Match Record

正式产物是单个 `<matchId>.match.json`：

- `off`：不保存；
- `replay`：定义、元数据、初末状态和 tick delta；
- `evaluation`：增加命令结果、Agent turn、工具和模型请求指标；
- `includeTranscript`：可选增加完整模型 messages 与 assistant 输出。

终局只写一次文件；运行中数据保留在内存，不重写大 JSON。不生成单独 transcript、详细因果记录、临时事实工作区、状态 hash 或自动 retention 产物。

`@llmcraft/record` 是 server/client 共用的 Match Record 读取与状态投影包。它能导入项目已有的普通旧 JSON；不实现已删除的详细记录格式兼容。

`analyze-record.mjs` 是供开发者或 Agent 离线分析已有 Match Record 的工具。它与 benchmark runner 相互独立。

## 7. Benchmark

- 当前 benchmark 是 LLM preset 对 `random` 或 `rush` built-in CPU。
- CPU 是模型/提示词的最低能力 baseline，不是性能规模测试，也不是平衡样本。
- `BenchmarkRunner` 直接处理轮次、换边、并发和汇总；没有通用 ExperimentRunner。
- `recordReplay=false` 时 round 不生成 Match Record；开启时使用 evaluation 档位，可另行选择 transcript。

## 8. 当前明确限制

- `summary` 仍是服务端拼装字符串。
- `ContextWindowLimiter` 只会丢弃/截断上下文，没有语义摘要。
- 完整 Match Record 的 tick delta 和 evaluation 数据在终局前留在内存，长局内存仍需实测。
- 当前地图定义虽然完整，但 SimulationCore 仍只接受内置 standard 布局。
- 人类手操 adapter 尚未实现；当前没有占位的 HumanControllerAdapter。
