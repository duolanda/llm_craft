# ADR 0003：Controller 与模型传输、Agent 会话分层

- 状态：Accepted
- 日期：2026-07-16
- 关联：[Roadmap](../roadmap.md)

## 背景

当前 `LLMProvider` 同时表示供应商传输、对话历史、工具循环和某种玩家控制器；为 benchmark 编写的内建脚本策略也伪装成 Provider。模型请求耗时还会间接影响可获得的行动次数，使模型速度与游戏策略混为一谈。

## 决策

- `Controller` 表示一个正式决策来源；LLM、CLI 和人类控制分别实现该接口。
- 确定性脚本只是测试驱动，用于规则回归、确定性和规模压测；它经 test adapter 调用 CommandGateway，不作为产品玩家或模型评估对手。
- `ModelTransport` 是无状态模型 API 传输层，只处理请求、响应、重试、限流和供应商指标。
- `AgentSession` 持有 Prompt、历史、上下文压缩、MemoryPolicy、工具循环和模型 trace。
- `ObservationProjection` 生成 Controller 可见状态；Controller 只能通过 CommandGateway 产生游戏动作。
- 高层决策可以生成 `Mission`；`MissionRuntime` 按模拟 tick 确定性执行后续生产、采矿、编队、进攻或回防步骤。
- 宏观决策额度按模拟时间和公开预算分配；模型响应快慢不能无限增加决策次数。紧急战术响应使用独立、受预算的事件触发额度。
- 子 Agent 使用独立 Controller 身份，并受单位/建筑 lease、并发数、请求预算和审计约束。

## 所有权约束

| 状态或能力 | 所有者 |
|---|---|
| API 调用与供应商重试 | ModelTransport |
| 对话、Prompt、MemoryPolicy、工具循环 | AgentSession |
| 玩家决策额度 | Controller scheduler |
| 多 tick 任务执行 | MissionRuntime |
| 游戏状态修改 | SimulationCore，经 CommandGateway 输入 |

## 迁移顺序

1. 为现有 LLM runtime 增加 Controller adapter，不立即改 Prompt。
2. 从 Provider 中拆出 ModelTransport 与 AgentSession。
3. 将内置脚本策略从产品运行时剔除，仅保留有价值的确定性测试行为，并改为独立 test adapter。
4. 引入 mission 和模拟时间预算，再评估/启用子 Agent。

## 明确不做

- 不因一次 turn 内有多轮标准 tool loop 就判定架构失败。
- 不用简单超时把慢模型结果随机丢弃；过期与取消必须有明确策略和 trace。
- 在 lease 和预算落地前，不扩展子 Agent 数量或能力面。

## 影响

该分层增加接口数量，但能分别测量模型传输、Agent 推理和游戏控制，避免 CLI 或测试脚本被迫实现模型专属能力，并为宏观策略与低频任务执行提供稳定边界。
