# LLMCraft 当前 MVP 现状说明

日期: 2026-04-19

这份文档只描述当前代码真实行为，不描述理想设计。

## 1. 当前系统边界

- 前端: React + Vite + Canvas
- 后端: Node.js + TypeScript
- 游戏 Tick: `500ms`
- AI 唤醒频率: 默认每 `5 tick` 触发一次
- AI 决策方式: OpenAI-compatible tool calling agent runtime
- 旧的 `AISandbox + Node vm + 生成 JavaScript` 链路已移除
- 模型配置来源: 服务端预设库（磁盘加密存储）
- live match 与 benchmark 现在共用同一套 runtime 外壳

## 2. 当前可见信息与工具结构

当前 AI 已不再使用也不再保留 `AIPromptPayload(full/delta)` 旧链路。

每次被唤醒时，模型只会收到：

- 固定 `system prompt`
- 持续对话历史
- 当前 `AgentRunInput`

当我方 HQ 已处于敌方攻击范围内时，`summary` 会额外插入固定警告：

- `Alert: our HQ is under attack.`

模型通过工具读取局面：

- `get_map_state`: 全图可见战场信息
- `get_my_state`: 我方经济、HQ、建筑、生产能力
- `get_my_units`: 我方可直接控制单位
- `get_active_plans`: 当前高层计划
- `get_recent_events`: 近期 AI-facing 反馈

只读工具结果都会带当前 `tick`。其中 `get_my_units` 返回 `{ tick, units }`，`get_active_plans` 返回 `{ tick, plans }`，`get_recent_events` 返回 `{ tick, events }`。

同一个长 run 中，新的同名同参数读取会把旧读取结果折叠为 `expired: true` tombstone；assistant 思考文本和动作工具结果保留。这个机制用于避免旧地图、旧单位表和旧 recent events 在上下文中长期污染后续判断。

模型通过工具改变局面：

- `move_unit`
- `attack_unit`
- `attack_in_range`
- `spawn_unit`
- `build_structure`
- `hold_unit`
- `orchestrate_plan`

动作/计划工具会先做明显无效请求的即时校验；单位、建筑或敌方目标不存在时直接返回 `ok: false` 和 `hint`，不会入队。所有动作/计划结果都会带当前 `tick`，如果本轮没有读取过局势或最后一次读取已超过 10 ticks，会额外返回 stale warning，但 warning 本身不阻止命令入队。

## 3. 当前高层计划能力

`orchestrate_plan` 采用扁平 steps DSL。

当前支持：

- 顺序执行
- `loop = -1` 无限循环
- `wait_until`
- `branch`
- `move_to`
- `attack_in_range`
- `hold_position`
- `stop`

即时动作会打断同一单位的当前计划。

## 4. 当前记录机制

回放与 transcript 现在记录的是 agent 行为，不是 JavaScript 代码。

当前 `aiTurns` 会保存：

- `runInput.summary`
- assistant 文本
- tool calls
- 注册的 plans
- 本轮入队的 commands
- stop reason
- metrics

当前 transcript 会保存：

- summary
- assistant text
- tool calls
- commands
- plans
- metrics

## 5. 当前 MVP 规则

- 建筑只保留 `hq` 和 `barracks`
- 单位只保留 `worker` 和 `soldier`
- 开局每方 `1 HQ + 2 Worker`
- 胜负条件是摧毁敌方 `HQ`
- 当前地图 `21 x 21`
- 当前没有战争迷雾
- `worker` 自动采矿，回 HQ 周围 1 格自动交付
- `barracks` 不能紧贴己方 `HQ`

## 6. 当前限制

- 当前仍然是服务端每连接 `100ms` 推一次 `state`
- 当前 `summary` 仍是服务端拼装的轻量文本，不是严格结构化状态摘要
- 当前 tool-calling provider 基于 OpenAI-compatible chat completions 工具调用
- 当前 plan 推进是 orchestrator 轮询驱动，实际执行相对 tick 有一个轻微的观察/入队延迟
