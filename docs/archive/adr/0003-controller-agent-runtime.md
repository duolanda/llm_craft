# ADR 0003：Controller 与模型传输、Agent 会话分层

- 状态：Amended by ADR 0005
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

当前 `LLMProvider` 同时表示供应商传输、对话历史、工具循环和某种玩家控制器；为 benchmark 编写的内建脚本策略也伪装成 Provider。模型请求耗时还会间接影响可获得的行动次数，使模型速度与游戏策略混为一谈。

## 当前决策

- `GameplayController` 是统一玩法控制面；LLM、CLI 与 CPU adapter 都通过它观察和下令。
- `DecisionController` 仅表示可由 tick 调度的决策来源。LLM 与 CPU 实现该接口；CLI 由外部请求触发。
- 当前没有人类手操入口，也不保留占位 adapter。
- `ModelTransport` 是无状态模型 API 传输层，只处理请求、响应、重试、限流和供应商指标。
- `AgentSession` 持有 Prompt、会话历史和工具循环。
- `ContextWindowLimiter` 只做临时硬限长，不是持久 memory 或真正的语义 compactor。
- `MissionRuntime` 按 committed tick 推进已经注册的多 tick 计划。
- built-in CPU 是 LLM benchmark 的最低能力基线，不伪装成模型 provider。
- 每个 committed tick 都可触发新的决策；某方仍有请求在运行时只跳过该方，不设置固定宏观间隔或额外命令预算。

## 所有权约束

| 状态或能力 | 所有者 |
|---|---|
| API 调用与供应商重试 | ModelTransport |
| 对话、Prompt、工具循环 | AgentSession |
| 临时上下文硬限长 | ContextWindowLimiter |
| 决策触发与 in-flight 去重 | GameOrchestrator |
| 多 tick 任务执行 | MissionRuntime |
| 玩法观察与动作转换 | GameplayController |
| 游戏状态修改 | Game 与 SimulationCore，经 CommandGateway 输入 |

## 明确不做

- 不因一次 turn 内有多轮标准 tool loop 就判定架构失败。
- 不用简单超时把慢模型结果随机丢弃；过期与取消必须有明确策略。
- 在 lease 和预算落地前，不扩展子 Agent 数量或能力面。

## 影响

该分层能分别测量模型传输、Agent 推理和游戏控制，同时让不同 adapter 复用同一套玩法工具与命令转换。
