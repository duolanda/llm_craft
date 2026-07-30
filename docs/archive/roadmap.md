# LLMCraft Roadmap

> 状态：Active
>
> 最后更新：2026-07-26

本文只记录 ADR 0005 重构后的产品与工程方向。当前事实以代码、[当前架构指南](./current-architecture-guide.md)、[当前实现现状](./current-mvp-reality.md)和 [AI API Contract](./ai-api-contract.md) 为准；具体缺陷在 [当前问题清单](./sprint/current-issues.md) 跟踪。

## 1. 当前基线

LLMCraft 已具备一条统一的可玩、可观察、可回放链路：

- `MatchRuntime`、`CommandGateway`、`Game` 和 `SimulationCore` 形成服务端权威模拟边界；
- LLM、CLI 和 built-in CPU 通过 `GameplayController` 使用相同玩法语义；
- `MatchRegistry` 管理 live、control 和 benchmark 对局及 Web UI 观察选择；
- WebSocket 使用 keyframe/delta 实时投影，React Three Fiber 客户端负责 3D 表现；
- `@llmcraft/record` 校验 Match Record、导入历史普通 JSON 并提供 replay 投影；
- `BenchmarkRunner` 直接负责 rounds、换边、并发和结果汇总；
- 标准地图为 144×96，已有采矿、建造、生产、步兵、反装甲步兵、轻坦和多建筑科技链。

当前明确不包含：独立 Trace 产品、MatchJournal、持久 DomainEvent 事实流、state hash、RNG checkpoint、通用 ExperimentRunner、journal recovery 或 artifact retention 平台。未来若出现真实消费者和失败样本，应通过新 ADR 重新论证，而不是恢复已删除的抽象。

## 2. 近期目标

### 2.1 用真实 LLM 长局验证性能

- 在 144×96 地图和大军团场景记录 tick wall time、RSS、浏览器 working set 与终局保存耗时；
- 分离首次 A*、局部避障、状态投影、Agent 请求和 Match Record 组装成本；
- 以真实瓶颈决定是否引入有界采样或简单分段文件，不预建恢复平台。

### 2.2 改善 Agent 上下文

- 为真正的语义 compactor 定义模型可读摘要契约；
- 明确保留战略理由、active plans、关键敌情和 tool-call/result 配对；
- 在此之前继续把 `ContextWindowLimiter` 视为临时消息数/字节上限，而不是 memory。

### 2.3 收敛观察工具与失败反馈

- 用真实 model request 数据判断状态工具是否过碎、是否存在重复读取循环；
- 保持即时动作的结构化恢复候选和 plan 的 `waiting.code/message/details`；
- 将字符串 `summary` 逐步收敛为可评估的结构化变化，同时控制 prompt 体积。

### 2.4 完成长局移动与战斗复测

- 复测轻坦 OBB、步兵圆形碰撞、局部避障和拥堵逃生在大规模混编中的稳定性；
- 继续保证 A* 只处理静态拓扑，动态单位冲突保持有界；
- 新增碾压、让行或 locomotion layer 交互时，通过 movement profile 和模拟事件实现，不向渲染层或寻路器堆特例。

## 3. 中期产品方向

### 3.1 更有辨识度的战略行为

- 让模型稳定表现分兵、佯攻、扰矿、回防和兵种协同；
- 扩展跨 tick Mission 表达能力，但避免把固定战术脚本写进 system prompt；
- 用换边、重复运行和明确样本量区分策略提升、出生方位偏差和偶然性。

### 3.2 Replay 与评估体验

- 让主回放、诊断和 transcript 视图围绕同一个 Match Record 工作；
- 对 evaluation record 展示 Agent turn、模型请求耗时、tokens、工具调用和命令结果；
- 保持 replay record 足够轻量，不要求每次保存完整 transcript。

### 3.3 画面与可读性

- 提升大军团选择、编队意图、攻击目标、生产状态和资源路线的可视反馈；
- 保证 UI/HUD 不遮挡战场，并控制长局浏览器内存与 draw-call 成本；
- 让实时插值和确定性回放各自使用适合的时序策略。

## 4. 长期方向

- 更丰富的地图、科技、兵种克制和胜利条件；
- 可重复的模型/prompt 对战基准与批量报告；
- 从 Match Record 中提取可解释的经济、战斗、响应速度和策略指标；
- 在出现第二个真实消费者后，再评估是否需要抽象通用实验调度层；
- 在出现恢复、审计或超长记录的实际需求后，再评估分段容器或持久事件流。

## 5. 演进原则

1. 先用失败样本和调用者证明新抽象的必要性。
2. 模拟状态只能在 MatchRuntime tick 边界经 CommandGateway 修改。
3. Live、CLI、Benchmark 和 Replay 必须共享同一套对局语义。
4. CPU-vs-CPU 只用于确定性规则和规模 smoke，不作为模型、策略或平衡结论。
5. 规则、Prompt、模型或架构调整要用可复现对局说明行为变化。
6. 旧 ADR 和 baseline 保留历史事实，但不得作为当前实现说明。
