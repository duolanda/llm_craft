# Sprint - 当前问题清单

> 只记录当前代码仍存在或本轮刚关闭的问题；历史设计不继续作为现状累积。

## 高优先级

### 1. 大地图与长局性能仍需真实 LLM 对局复测

- **现状**：Agent read path 已减少重复完整状态读取，WebSocket 对慢客户端采用 latest-projection-wins；任意阻塞单位现在都可重新寻路，不再使用每 tick 4 次额度。
- **风险**：144x96 地图、大军团 A*、状态序列化和终局 Match Record JSON 仍可能造成 CPU 或内存峰值。
- **验收**：用真实双 LLM 长局记录 tick wall time、RSS、浏览器 working set 和终局保存耗时。

### 2. ContextWindowLimiter 不是真正的 compactor

- **现状**：当前只按消息数量/字节删除旧 user 边界段，并截断超大消息。
- **风险**：模型会失去较早的战略理由和任务上下文；它不能替代持久 memory 或 Codex/pi 风格语义压缩。
- **下一步**：先定义模型可读摘要契约与保留事实，再实现真正 compactor。

### 3. Match Record 运行中历史仍在内存

- **现状**：为删除运行中事实工作区和重写复杂度，Match Record 只在终局写一次。
- **风险**：极长 evaluation 对局会累积 tick delta、turn 和命令结果。
- **下一步**：先以真实长局数据证明问题，再选择有界采样或简单分段文件；不预建恢复/审计平台。

## 中优先级

### 4. `summary` 仍是字符串拼装

- **影响**：能工作，但不利于精确评估模型收到了哪些结构化变化。

### 5. 只读工具仍偏碎

- **现状**：`get_map_state / get_my_state / get_my_units / get_army_summary / get_active_plans / get_recent_events`。
- **方向**：有真实模型调用数据后再判断是否合并，不继续增加新查询工具。

### 6. Benchmark 前端缺少完整 Agent 指标

- **现状**：离线 Match Record 可以看到 model request、tool call 和 latency；实时结果面板只显示胜负、时长和少量汇总。

### 7. 3D 战斗表现仍缺正式动画

- **现状**：单位/建筑模型、弹丸和基本碰撞已存在；步兵仍缺完整行走、射击和死亡动画。

### 8. 浏览器控制台仍有非阻塞告警

- **现状**：首次连接时可能短暂记录一次 WebSocket error/disconnect 后自动重连；Three.js 还会报告 `THREE.Clock` 已弃用。
- **影响**：本轮真实对局、终局和保存均未受影响，但会给前端诊断增加噪音。

## 本轮已完成

- [x] 将 `feat/3d` 之后的历史提交压成一个 commit，保留本轮未提交修改。
- [x] 普通 live 拒绝重复 start；重复 `llmcraft play` 只报告 active match；前端可切换观察 registry 中的对局。
- [x] 将 HQ 和初始单位位置纳入 `MapDefinition.playerStarts`。
- [x] 删除每 actor 100 条命令、每 tick 4 条路径命令和阻塞重寻路额度。
- [x] 删除 envelope/tick checkpoint 与回滚；CLI batch 改为逐 action 部分成功。
- [x] 删除 state hash、RNG checkpoint、持久 DomainEvent、事实工作区和自动 artifact retention。
- [x] 删除 100ms poll，改为 committed tick / match ended 通知。
- [x] group attack move 一次提交全部编队命令，删除跨 tick pending release。
- [x] `AgentMemoryPolicy` 改为 `ContextWindowLimiter`，并明确其临时性质。
- [x] `GameAgentBridge` 改为统一 `GameplayController`；调度来源改称 `DecisionController`。
- [x] `BuiltinTestController` 改为 `BuiltinCPUController`，CPU 定位为模型 benchmark baseline。
- [x] `ExperimentRunner` 收回为 `BenchmarkRunner`；`analyze-record.mjs` 保持独立。
- [x] 统一为 Match Record，提供 off/replay/evaluation 与可选 transcript；删除详细记录格式、状态 hash 和独立人类日志。
- [x] 用真实 CLI-vs-rush 对局验证 Registry、GameplayController、WebSocket 3D 投影、自然终局、自动保存和离线分析链路。
- [x] 修复真实终局中 control state 已有 winner、lobby status 仍显示 `running` 的不一致，并增加回归测试。
