# Sprint - 当前问题清单

> 记录当前 MVP 中仍然存在的真实问题和待改进项

## 高优先级

### 1. WebSocket 状态同步仍是定时推送
- **描述**: 当前 `state` 仍然是每连接 `100ms` 固定推送一次，不是严格事件驱动
- **影响**: 有额外序列化和无效推送开销，后续做更细粒度同步会受限

### 2. tool-calling runtime 缺少更细的行为指标下发
- **描述**: 服务端内部已记录 `modelRequests / toolCalls / stallDetected`，但 benchmark 对外消息还没有把这些指标完整暴露到前端
- **影响**: 能做离线分析，但前端实时面板还看不到完整的 agent 行为统计

### 3. `summary` 仍然是字符串拼装
- **描述**: 当前 `summary` 已经取代旧 `full/delta` 主输入，但仍是服务端拼接文本
- **影响**: 可工作，但结构化程度不高，不利于后续精细优化

### 4. 计划推进与 tick 执行之间仍有轻微延迟
- **描述**: 当前计划推进由 orchestrator 轮询观察 tick 后再入队
- **影响**: 相比直接嵌入 tick 前阶段，存在轻微的一 tick 级延迟风险

## 中优先级

### 5. 预设仍缺少 temperature
- **描述**: 当前预设只有 baseURL、model、rpm，没有 temperature
- **影响**: 无法用预设层面调整模型稳定性/随机性

### 6. 查询类工具仍然偏碎，后续需要收敛
- **描述**: 当前只读工具拆成了 `get_map_state / get_my_state / get_my_units / get_active_plans / get_recent_events`
- **影响**: 对 agent 来说查询入口偏多，后续需要收敛到 `3` 个（查地图、查自己、recent）或 `2` 个（查所有、recent）工具，并主要通过简单参数完成过滤，而不是继续增加新读工具

### 7. 高级编排层仍然偏扁平，后续需要探索更灵活的管道式表达
- **描述**: 当前 `orchestrate_plan` 还是 `steps + loop + branch + wait_until` 的扁平 DSL
- **影响**: 能覆盖基础长期任务，但表达力仍有限；后续需要评估是否升级到类似 bash 管道的组合方式，例如 `A | B | C` 这样的串联/筛选/执行模型，以提升灵活性

### 8. Benchmark 面板还没消费新 runtime 细节
- **描述**: 服务端内部已有 tool calls / plans / stopReason 等 runtime 细节，但 benchmark 结果面板还未充分展示
- **影响**: 回放已经能看到 tool-driven agent 行为，但 benchmark 视角仍不够完整

### 9. 日志文件名时间戳仍使用 UTC 时间
- **描述**: 当前对局日志/回放等文件名里的时间戳使用 UTC 时间，与本地开发和排查时常用的北京时间不一致
- **影响**: 按文件名定位具体对局时需要额外换算时区，容易和控制台、本地观察时间产生偏差；后续可评估改为北京时间或在文件名中显式标注时区

## 已完成 ✅

- [x] 移除 `AISandbox` 与 `Node vm` 主链路
- [x] live match 切到 tool-calling agent runtime
- [x] benchmark 切到同一套 tool-calling runtime
- [x] 只读工具统一为 `get_map_state / get_my_state / get_my_units / get_active_plans / get_recent_events`
- [x] 引入 `orchestrate_plan` 扁平 DSL
- [x] 回放与 transcript 改为记录 tool calls / plans / commands / stop reason
- [x] 修复 action tool 命令要等整轮 agent run 结束后才入队，导致长链 tool-calling 期间单位表面“无动作”的时序问题
- [x] 为 tool-calling runtime 增加工具结果 tick、动作预校验和 stale-read warning，减少长 run 使用过期单位/建筑 ID 的无效命令
- [x] 为 OpenAI-compatible provider 增加同名同参数 read tool result 折叠，保留 assistant 文本但淘汰旧观察大 JSON
- [x] 清理 `AIStatePackageBuilder` 与 `AIPromptPayload(full/delta)` 兼容残留
- [x] 修复单位走到目标后仍保留 `moving` 状态与一次性 `move` intent，导致 agent 误判单位还在移动
- [x] 将 `get_map_state` 默认响应压缩为 ASCII 小地图 + 实体列表，并把逐格 `cells` 改为显式请求
- [x] 暴露内建 `start_harvest_loop` 工具，避免 agent 用 `orchestrate_plan` 手写采矿往返
- [x] 增加 `analyze:record` 离线回放分析脚本，用于统计囤钱、worker 过量、生产瓶颈、战斗命令噪声和 HQ 受击时机
- [x] 暴露默认只自动攻击单位的 `attack_move_unit`，让士兵前压时不会无视路上敌军，同时保留攻击 HQ / barracks 必须显式下令的战略约束
- [x] 用高层 `attack(unitId, targetId)` 替代 LLM 暴露面的 `attack_unit` / `attack_in_range`，由 bridge 负责追击、持续攻击和目标死亡后的最后位置移动
- [x] 限制 `attack_move_unit` 到达目标点后结束，避免士兵在敌方基地永久自动清理后续新单位
- [x] 明确 `attack` 是有目标 ID 时的默认战斗命令，避免 LLM 把 `attack_move_unit` 当成拆 HQ / barracks 的替代品

---

*最后更新: 2026-05-02*
