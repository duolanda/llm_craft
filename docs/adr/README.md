# LLMCraft 架构决策记录

本目录记录 Roadmap 核心迁移中的稳定架构边界。ADR 一旦进入 `Accepted`，后续实现若要偏离，必须新增 ADR 说明替代关系，不能只在代码中静默改变方向。

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-match-runtime-ownership.md) | Accepted | MatchRuntime、SimulationCore 与对局所有权 |
| [0002](0002-command-event-contract.md) | Superseded in part | CommandEnvelope 与 CommandGateway；持久事件流由 0005 删除 |
| [0003](0003-controller-agent-runtime.md) | Amended | AgentSession 与 ModelTransport 分层；Controller 命名由 0005 修正 |
| [0004](0004-record-trace-journal.md) | Superseded | 由 0005 的轻量 Match Record 取代 |
| [0005](0005-terminology-and-control-boundaries.md) | Accepted | 统一术语、两个控制面与 Match Record |
