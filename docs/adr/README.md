# LLMCraft 架构决策记录

本目录记录 Roadmap 核心迁移中的稳定架构边界。ADR 一旦进入 `Accepted`，后续实现若要偏离，必须新增 ADR 说明替代关系，不能只在代码中静默改变方向。

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-match-runtime-ownership.md) | Accepted | MatchRuntime、SimulationCore 与对局所有权 |
| [0002](0002-command-event-contract.md) | Accepted | CommandEnvelope、CommandGateway 与 DomainEvent |
| [0003](0003-controller-agent-runtime.md) | Accepted | Controller、AgentSession 与 ModelTransport 分层 |
| [0004](0004-record-trace-journal.md) | Accepted | Record/Trace Journal 与分析事实源 |
